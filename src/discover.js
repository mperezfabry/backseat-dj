import * as spotify from './spotify.js';

// Spotify no longer gives small apps charts or recommendations, so the "top songs" list comes from
// Apple Music's public chart feed and each song is matched on Spotify.
const CHART_URL = 'https://rss.marketingtools.apple.com/api/v2/us/music/most-played/25/songs.json';
const REFRESH_MS = 6 * 60 * 60_000;
const RETRY_MS = 2 * 60_000;

const log = (...args) => console.log(new Date().toISOString(), ...args);

// "Song (feat. Someone) [Remix]" -> "Song", and no quotes that would break Spotify's field filters.
const clean = (text) => text.replace(/\s*[([].*?[)\]]/g, '').replace(/"/g, '').trim();

async function loadChart() {
  const res = await fetch(CHART_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Apple chart feed returned ${res.status}`);
  const entries = (await res.json()).feed?.results ?? [];
  const tracks = [];
  for (const entry of entries) {
    const artist = clean(entry.artistName.split(/,|&/)[0]);
    const [hit] = await spotify.search(`track:"${clean(entry.name)}" artist:"${artist}"`, { limit: 1 }).catch(() => []);
    if (hit && !tracks.some((t) => t.id === hit.id)) tracks.push(hit);
  }
  return tracks;
}

function cached(name, load) {
  let value = [];
  let nextRefresh = 0;
  let inFlight = null;
  return async () => {
    if (Date.now() >= nextRefresh) {
      inFlight ??= load()
        .then((tracks) => {
          value = tracks;
          nextRefresh = Date.now() + REFRESH_MS;
          log(`Loaded ${tracks.length} tracks for "${name}"`);
        })
        .catch((err) => {
          nextRefresh = Date.now() + RETRY_MS;
          log(`Couldn't load "${name}": ${err.message}`);
        })
        .finally(() => { inFlight = null; });
      // Only make the rider wait the very first time; afterwards serve the old list while refreshing.
      if (!value.length) await inFlight;
    }
    return value;
  };
}

const chart = cached('Top songs right now', loadChart);
const picks = cached("Driver's picks", spotify.topTracks);

export async function sections() {
  const [driverPicks, top] = await Promise.all([picks(), chart()]);
  return [
    { id: 'picks', title: 'Driver’s picks', tracks: driverPicks },
    { id: 'top', title: 'Top songs right now', tracks: top },
  ].filter((s) => s.tracks.length);
}
