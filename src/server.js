import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import QRCode from 'qrcode';
import { config } from './config.js';
import * as discover from './discover.js';
import * as rides from './ride.js';
import * as spotify from './spotify.js';
import * as watcher from './watcher.js';

const page = (name) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url));
const pages = { rider: page('rider.html'), admin: page('admin.html') };
const secureCookies = config.publicUrl.startsWith('https://');
const oauthStates = new Map(); // state -> expiresAt

// Browsers must not frame these pages, sniff types, or load scripts/images from anywhere but here and Spotify's CDN.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://i.scdn.co https://*.spotifycdn.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self' https://accounts.spotify.com",
    "base-uri 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
};

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new rides.UserError('Expected JSON', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new rides.UserError('Request too large', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new rides.UserError('Invalid JSON');
  }
}

function cookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(config.adminPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

/** HTTP Basic auth; any username, password = ADMIN_PASSWORD. */
function isAdmin(req) {
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  return passwordMatches(decoded.slice(decoded.indexOf(':') + 1));
}

/**
 * Fixed-window rate limits. Keyed per phone where possible, plus a shared cap so someone
 * clearing cookies in a loop still can't burn through the Spotify API quota.
 */
const hits = new Map(); // key -> { count, resetAt }
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    hits.set(key, entry);
  }
  if (++entry.count > max) throw new rides.UserError('Slow down a little and try again in a moment.', 429);
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
}, 60_000).unref();

function limitRider(req, action, perPhone, overall) {
  rateLimit(`${action}:all`, overall, 60_000);
  rateLimit(`${action}:${cookie(req, 'device') ?? 'none'}`, perPhone, 60_000);
}

// One long-lived ID per rider phone, so a phone banned after its ride stays banned.
const deviceCookie = (id) =>
  `device=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${5 * 365 * 24 * 3600}${secureCookies ? '; Secure' : ''}`;

// A wrong password costs a second, so guessing is hopeless (and the password is 20 random characters anyway).
async function askForAdmin(req, res) {
  if (req.headers.authorization) await new Promise((resolve) => setTimeout(resolve, 1000));
  send(res, 401, 'Password required', { 'WWW-Authenticate': 'Basic realm="Backseat DJ"' });
}

// ---------- routes ----------

const routes = {
  'GET /': (req, res) => send(res, 200, pages.rider),
  'GET /healthz': (req, res) => send(res, 200, { ok: true }),

  // Rider API
  'POST /api/join': (req, res) => {
    rateLimit('join:all', 60, 60_000);
    const existing = cookie(req, 'device');
    const deviceId = existing ?? rides.newDeviceId();
    rides.join(deviceId);
    send(res, 200, { ok: true }, existing ? {} : { 'Set-Cookie': deviceCookie(deviceId) });
  },
  'GET /api/me': (req, res) => send(res, 200, rides.riderState(cookie(req, 'device'))),
  'GET /api/search': async (req, res, url) => {
    limitRider(req, 'search', 30, 120);
    const tracks = await rides.search(cookie(req, 'device'), url.searchParams.get('q'), {
      shuffle: url.searchParams.get('shuffle') === '1',
    });
    send(res, 200, { tracks });
  },
  'GET /api/recommendations': async (req, res) => {
    limitRider(req, 'recs', 10, 60);
    send(res, 200, { sections: await rides.recommendations(cookie(req, 'device')) });
  },
  'POST /api/queue': async (req, res) => {
    limitRider(req, 'queue', 10, 40);
    const body = await readJson(req);
    await rides.addSong(cookie(req, 'device'), String(body.trackId ?? ''));
    send(res, 200, rides.riderState(cookie(req, 'device')));
  },
  'POST /api/skip': async (req, res) => {
    limitRider(req, 'skip', 6, 30);
    await rides.voteSkip(cookie(req, 'device'));
    send(res, 200, rides.riderState(cookie(req, 'device')));
  },

  // Admin
  'GET /admin': (req, res) => (isAdmin(req) ? send(res, 200, pages.admin) : askForAdmin(req, res)),
  'GET /admin/api/status': (req, res) => (isAdmin(req) ? send(res, 200, rides.adminState()) : askForAdmin(req, res)),
  'POST /admin/api/end-ride': (req, res) => {
    if (!isAdmin(req)) return askForAdmin(req, res);
    send(res, 200, { ended: rides.endRide('ended from admin page') });
  },
  'POST /admin/api/clear-bans': (req, res) => {
    if (!isAdmin(req)) return askForAdmin(req, res);
    send(res, 200, { cleared: rides.clearBans() });
  },
  'GET /admin/qr.svg': async (req, res) => {
    if (!isAdmin(req)) return askForAdmin(req, res);
    const svg = await QRCode.toString(`${config.publicUrl}/`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    send(res, 200, svg, { 'Content-Type': 'image/svg+xml' });
  },
  'GET /admin/connect-spotify': (req, res) => {
    if (!isAdmin(req)) return askForAdmin(req, res);
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now() + 10 * 60_000);
    send(res, 302, '', { Location: spotify.authorizeUrl(state) });
  },
  'GET /callback': async (req, res, url) => {
    const state = url.searchParams.get('state');
    const expiresAt = oauthStates.get(state);
    oauthStates.delete(state);
    if (!expiresAt || expiresAt < Date.now()) return send(res, 400, 'Login link expired. Go back to /admin and try again.');
    if (url.searchParams.get('error')) return send(res, 400, `Spotify said: ${url.searchParams.get('error')}`);
    await spotify.exchangeCode(url.searchParams.get('code'));
    send(res, 302, '', { Location: '/admin' });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'Not found' });
  try {
    await handler(req, res, url);
  } catch (err) {
    if (err instanceof rides.UserError) return send(res, err.status, { error: err.message });
    console.error(new Date().toISOString(), `${req.method} ${url.pathname} failed:`, err);
    if (err instanceof spotify.SpotifyError && err.status === 429) {
      return send(res, 503, { error: 'Spotify is busy. Try again in a minute.' });
    }
    send(res, 500, { error: 'Something went wrong. Try again.' });
  }
});

await spotify.loadTokens();
watcher.start();
server.listen(config.port, () => {
  console.log(`Backseat DJ listening on :${config.port} (public URL ${config.publicUrl})`);
  if (!spotify.isConnected()) console.log(`Open ${config.publicUrl}/admin to connect Spotify.`);
  // Warm the suggestion shelves so the first rider of the day doesn't wait for them.
  else setTimeout(() => discover.sections().catch(() => {}), 5000);
});
