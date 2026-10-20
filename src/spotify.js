import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-top-read', // "Driver's picks" on the rider page
];
const redirectUri = `${config.publicUrl}/callback`;
const tokenFile = path.join(config.dataDir, 'spotify-tokens.json');

export class SpotifyError extends Error {
  constructor(status, message, { reason, retryAfter } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

let tokens = null; // { access_token, refresh_token, expires_at }
let refreshing = null;

export async function loadTokens() {
  try {
    tokens = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
  } catch {
    tokens = null;
  }
}

async function saveTokens() {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(tokenFile, JSON.stringify(tokens));
}

export const isConnected = () => Boolean(tokens?.refresh_token);

export function authorizeUrl(state) {
  const url = new URL(`${ACCOUNTS}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.spotifyClientId,
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri,
    state,
  });
  return url.toString();
}

async function tokenRequest(params) {
  const basic = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64');
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new SpotifyError(res.status, `Spotify token request failed: ${await res.text()}`);
  return res.json();
}

function storeTokens(t) {
  tokens = {
    access_token: t.access_token,
    // Spotify only sometimes rotates the refresh token.
    refresh_token: t.refresh_token ?? tokens?.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
  };
  return saveTokens();
}

export async function exchangeCode(code) {
  await storeTokens(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }));
}

async function accessToken() {
  if (!isConnected()) throw new SpotifyError(401, 'Spotify is not connected yet');
  if (tokens.access_token && Date.now() < tokens.expires_at - 60_000) return tokens.access_token;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    .then(storeTokens)
    .finally(() => { refreshing = null; });
  await refreshing;
  return tokens.access_token;
}

async function api(method, pathname, query) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401 && attempt === 0) {
      tokens.expires_at = 0; // force a refresh and retry once
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* some player endpoints reply with non-JSON */ }
    if (!res.ok) {
      throw new SpotifyError(res.status, body?.error?.message ?? (text || res.statusText), {
        reason: body?.error?.reason,
        retryAfter: Number(res.headers.get('retry-after')) || undefined,
      });
    }
    return body;
  }
}

function mapTrack(t) {
  const images = t.album?.images ?? [];
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).join(', '),
    art: (images[1] ?? images[0])?.url ?? null,
    durationMs: t.duration_ms,
  };
}

export async function search(q, { limit = 10, offset = 0 } = {}) {
  // Development-mode apps are capped at 10 results per search.
  const body = await api('GET', '/search', { q, type: 'track', limit: Math.min(limit, 10), offset });
  return (body?.tracks?.items ?? []).filter(Boolean).map(mapTrack);
}

/** The driver's most-played tracks over the last few weeks. */
export async function topTracks() {
  const body = await api('GET', '/me/top/tracks', { time_range: 'short_term', limit: 20 });
  return (body?.items ?? []).filter(Boolean).map(mapTrack);
}

/** What's playing on the driver's account, or null when nothing is. */
export async function currentlyPlaying() {
  const body = await api('GET', '/me/player/currently-playing', { additional_types: 'track,episode' });
  if (!body?.item) return null;
  return {
    uri: body.item.uri,
    track: body.item.type === 'track' ? mapTrack(body.item) : null,
    progressMs: body.progress_ms ?? 0,
    durationMs: body.item.duration_ms ?? 0,
    isPlaying: Boolean(body.is_playing),
  };
}

/** URIs of what plays next (user queue first, then the playlist/album context). */
export async function upcoming() {
  const body = await api('GET', '/me/player/queue');
  return (body?.queue ?? []).map((item) => item.uri);
}

export const addToQueue = (uri) => api('POST', '/me/player/queue', { uri });
export const skipNext = () => api('POST', '/me/player/next');
