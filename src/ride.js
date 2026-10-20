import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as discover from './discover.js';
import * as spotify from './spotify.js';

const PURGE_TTL_MS = 60 * 60_000;
const QUEUED_SONG_TTL_MS = 2 * 60 * 60_000;
const SEARCH_CACHE_SIZE = 1000;
const ACTIVE_PHONE_MS = 3 * 60_000; // phones seen this recently count toward vote-skip majorities
const FIRST_SONG_SKIP_DELAY_MS = 400;
const bannedFile = path.join(config.dataDir, 'banned-devices.json');

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Emits 'queue-changed' whenever Spotify's queue should be re-read. */
export const events = new EventEmitter();

// { startedAt, lastActivity, devices: Set<deviceId>, lastSeen: Map<deviceId, time>,
//   songs: [{ track, status, queuedAt }], skipVote: { uri, voters: Set<deviceId> } | null }
let ride = null;
let playback = null; // { uri, track, progressMs, durationMs, isPlaying, at }
const purge = new Map(); // track uri -> expiresAt
const searchCache = new Map(); // track id -> track, so riders can only queue real search results

// Phones that were in a ride that has ended. They can never join again (until the driver clears the list).
// Stored as hashes so the file on disk can't be used to impersonate a phone.
const banned = new Set(loadBanned());
const hash = (deviceId) => crypto.createHash('sha256').update(deviceId).digest('hex');

function loadBanned() {
  try {
    return JSON.parse(fs.readFileSync(bannedFile, 'utf8'));
  } catch {
    return [];
  }
}

function saveBanned() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(bannedFile, JSON.stringify([...banned]));
}

const log = (...args) => console.log(new Date().toISOString(), ...args);
const pending = (r) => r.songs.filter((s) => s.status !== 'done');

export const newDeviceId = () => crypto.randomBytes(24).toString('base64url');
export const isBanned = (deviceId) => banned.has(hash(deviceId));

// ---------- joining ----------

export function join(deviceId) {
  if (isBanned(deviceId)) throw new UserError('Your ride has ended. Thanks for riding!', 403);
  if (!ride) {
    ride = { startedAt: Date.now(), lastActivity: Date.now(), devices: new Set(), lastSeen: new Map(), songs: [], skipVote: null };
    log('Ride started');
    events.emit('queue-changed');
  }
  ride.devices.add(deviceId);
  touch(ride, deviceId);
  log(`Rider phone joined (${ride.devices.size} in ride)`);
}

function touch(r, deviceId) {
  r.lastActivity = Date.now();
  r.lastSeen.set(deviceId, Date.now());
}

function requireRide(deviceId) {
  if (!ride || !ride.devices.has(deviceId)) throw new UserError('This ride has ended. Thanks for riding!', 401);
  touch(ride, deviceId);
  return ride;
}

function rememberTracks(tracks) {
  for (const t of tracks) {
    searchCache.delete(t.id);
    searchCache.set(t.id, t);
  }
  while (searchCache.size > SEARCH_CACHE_SIZE) searchCache.delete(searchCache.keys().next().value);
}

/** Skip the current track ourselves; the watcher must not mistake it for the driver's double-skip. */
async function skipCurrent(why) {
  events.emit('own-skip');
  await spotify.skipNext();
  log(`Skipped "${playback?.track?.name ?? 'current track'}" (${why})`);
}

// Majority of the phones that are actually around: 1 of 1, 2 of 2, 2 of 3, 3 of 4...
function votesNeeded(r) {
  const now = Date.now();
  const active = [...r.lastSeen.values()].filter((t) => now - t < ACTIVE_PHONE_MS).length;
  return Math.floor(Math.max(active, 1) / 2) + 1;
}

// ---------- rider actions ----------

const publicSong = (s) => ({ ...s.track, status: s.status });

export function riderState(deviceId) {
  if (!deviceId) return { active: false, banned: false };
  if (!ride || !ride.devices.has(deviceId)) return { active: false, banned: isBanned(deviceId) };
  touch(ride, deviceId);
  const vote = ride.skipVote?.uri === playback?.uri ? ride.skipVote : null;
  return {
    active: true,
    limit: config.songLimit,
    songs: pending(ride).map(publicSong),
    nowPlaying: playback?.track && {
      ...playback.track,
      progressMs: playback.progressMs + (playback.isPlaying ? Date.now() - playback.at : 0),
      isPlaying: playback.isPlaying,
    },
    skip: { votes: vote?.voters.size ?? 0, needed: votesNeeded(ride), voted: Boolean(vote?.voters.has(deviceId)) },
  };
}

export async function search(deviceId, q, { shuffle = false } = {}) {
  requireRide(deviceId);
  q = String(q ?? '').trim().slice(0, 100);
  if (!q) return [];
  // Genre buttons ask for a random page so tapping one twice shows different songs.
  const tracks = await spotify.search(q, { offset: shuffle ? 10 * Math.floor(Math.random() * 3) : 0 });
  rememberTracks(tracks);
  return tracks;
}

export async function recommendations(deviceId) {
  requireRide(deviceId);
  const sections = await discover.sections();
  for (const section of sections) rememberTracks(section.tracks);
  return sections;
}

export async function addSong(deviceId, trackId) {
  const r = requireRide(deviceId);
  const track = searchCache.get(trackId);
  if (!track) throw new UserError('Search for that song again, then add it.');
  if (pending(r).length >= config.songLimit) {
    throw new UserError(`You can have ${config.songLimit} songs waiting at a time. Add another once one has played.`, 429);
  }
  try {
    await spotify.addToQueue(track.uri);
  } catch (err) {
    if (err.status === 404) throw new UserError('The driver’s music is paused right now. Try again in a bit.', 409);
    throw err;
  }
  const isFirstSong = r.songs.length === 0;
  r.songs.push({ track, status: 'queued', queuedAt: Date.now() });
  log(`Rider queued "${track.name}" by ${track.artists}`);
  events.emit('queue-changed');

  // The ride's first song plays right away instead of waiting for the driver's track to finish.
  if (isFirstSong && playback?.uri && playback.uri !== track.uri) {
    await new Promise((resolve) => setTimeout(resolve, FIRST_SONG_SKIP_DELAY_MS));
    await skipCurrent('first rider song').catch((err) => log(`Couldn't jump to first rider song: ${err.message}`));
  }
}

export async function voteSkip(deviceId) {
  const r = requireRide(deviceId);
  if (!playback?.uri) throw new UserError('Nothing is playing right now.', 409);
  if (r.skipVote?.uri !== playback.uri) r.skipVote = { uri: playback.uri, voters: new Set() };
  r.skipVote.voters.add(deviceId);
  const needed = votesNeeded(r);
  if (r.skipVote.voters.size >= needed) {
    r.skipVote = null;
    await skipCurrent(`riders voted ${needed}/${needed}`);
  }
}

// ---------- ending rides ----------

/**
 * Only the driver's own actions (double-skip, admin button) ban the ride's phones. Timeouts don't,
 * because a rider who just put their phone away may still be in the car.
 */
export function endRide(reason, { ban = true } = {}) {
  if (!ride) return false;
  const leftovers = pending(ride);
  for (const s of leftovers) purge.set(s.track.uri, Date.now() + PURGE_TTL_MS);
  if (ban) {
    for (const deviceId of ride.devices) banned.add(hash(deviceId));
    saveBanned();
  }
  log(`Ride ended (${reason}); ${ban ? `banned ${ride.devices.size} phone(s)` : 'no bans'}; ${leftovers.length} rider song(s) will be skipped if they come up`);
  ride = null;
  return true;
}

export function clearBans() {
  const count = banned.size;
  banned.clear();
  saveBanned();
  log(`Cleared ${count} banned phone(s)`);
  return count;
}

export const isRideActive = () => ride !== null;
export const hasPurges = () => purge.size > 0;

/** Called by the watcher on every poll. */
export function onNowPlaying(current) {
  playback = current ? { ...current, at: Date.now() } : null;
  if (!ride) return;
  const uri = current?.uri;
  for (const s of ride.songs) {
    if (s.status === 'playing' && s.track.uri !== uri) s.status = 'done';
  }
  const starting = ride.songs.find((s) => s.status === 'queued' && s.track.uri === uri);
  if (starting) starting.status = 'playing';
}

/** Called with Spotify's upcoming queue: rider songs no longer in it were skipped past. */
export function syncQueue(upcomingUris) {
  if (!ride) return;
  const upcoming = new Set(upcomingUris);
  for (const s of ride.songs) {
    if (s.status === 'queued' && !upcoming.has(s.track.uri)) s.status = 'done';
  }
}

/** Should the watcher skip this track because it belongs to a rider who's gone? */
export function shouldPurge(uri) {
  const expiresAt = purge.get(uri);
  if (!expiresAt) return false;
  purge.delete(uri);
  return expiresAt > Date.now();
}

export function maintenance() {
  const now = Date.now();
  for (const [uri, expiresAt] of purge) if (expiresAt <= now) purge.delete(uri);
  if (!ride) return;
  for (const s of ride.songs) if (s.status === 'queued' && now - s.queuedAt > QUEUED_SONG_TTL_MS) s.status = 'done';
  if (now - ride.startedAt > config.rideMaxMinutes * 60_000) endRide('max ride length', { ban: false });
  else if (now - ride.lastActivity > config.rideIdleMinutes * 60_000 && pending(ride).length === 0) endRide('idle', { ban: false });
}

// ---------- admin ----------

export function adminState() {
  return {
    spotifyConnected: spotify.isConnected(),
    songLimit: config.songLimit,
    nowPlaying: playback?.track ?? null,
    ride: ride && {
      startedAt: ride.startedAt,
      devices: ride.devices.size,
      songs: pending(ride).map(publicSong),
    },
    bannedPhones: banned.size,
    songsBeingPurged: purge.size,
  };
}
