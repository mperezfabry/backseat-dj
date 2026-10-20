import { config } from './config.js';
import * as rides from './ride.js';
import { countManualSkips } from './skips.js';
import * as spotify from './spotify.js';

const BUSY_POLL_MS = 3000; // while a ride is active or rider songs are waiting to be purged
const IDLE_POLL_MS = 15000;
const OWN_SKIP_GRACE_MS = 8000;

let prev = null; // last poll: { uri, progressMs, durationMs, isPlaying, at }
let upcoming = []; // Spotify's queue as of the last refresh
let queueStale = true;
let skipEvents = []; // { at, count } manual skips inside the double-skip window
let ignoreChangesUntil = 0; // our own purge skips aren't the driver's double-skip
let lastError = null;

rides.events.on('queue-changed', () => { queueStale = true; });
rides.events.on('own-skip', () => {
  ignoreChangesUntil = Date.now() + OWN_SKIP_GRACE_MS;
  queueStale = true;
});

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function tick() {
  if (!spotify.isConnected()) return;
  const now = Date.now();
  const current = await spotify.currentlyPlaying();
  const uri = current?.uri ?? null;
  const changed = prev !== null && uri !== prev.uri;

  rides.onNowPlaying(current);

  if (changed) {
    queueStale = true;
    const count = now < ignoreChangesUntil ? 0 : countManualSkips(prev, upcoming, uri, now);
    if (count > 0) {
      skipEvents = skipEvents.filter((e) => now - e.at < config.doubleSkipWindowMs);
      skipEvents.push({ at: now, count });
      if (skipEvents.reduce((sum, e) => sum + e.count, 0) >= 2) {
        skipEvents = [];
        rides.endRide('driver double-skipped');
      }
    }
  }
  prev = {
    uri,
    progressMs: current?.progressMs ?? 0,
    durationMs: current?.durationMs ?? 0,
    isPlaying: Boolean(current?.isPlaying),
    at: now,
  };

  if (uri && rides.shouldPurge(uri)) {
    log(`Skipping a leftover rider song (${current.track?.name ?? uri})`);
    ignoreChangesUntil = now + OWN_SKIP_GRACE_MS;
    await spotify.skipNext();
    queueStale = true;
  }

  if (queueStale && rides.isRideActive()) {
    upcoming = await spotify.upcoming();
    queueStale = false;
    rides.syncQueue(upcoming);
  }

  rides.maintenance();
}

export function start() {
  const loop = async () => {
    let delay = rides.isRideActive() || rides.hasPurges() ? BUSY_POLL_MS : IDLE_POLL_MS;
    try {
      await tick();
      lastError = null;
    } catch (err) {
      if (err.status === 429) delay = Math.max(delay, (err.retryAfter ?? 30) * 1000);
      if (err.message !== lastError) console.error(new Date().toISOString(), 'Watcher error:', err.message);
      lastError = err.message;
    }
    setTimeout(loop, delay);
  };
  loop();
}
