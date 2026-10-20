import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countManualSkips } from '../src/skips.js';

const t0 = 1_000_000;
const playing = (uri, progressMs, durationMs = 200_000) => ({ uri, progressMs, durationMs, isPlaying: true, at: t0 });

test('a song that ends on its own is not a skip', () => {
  assert.equal(countManualSkips(playing('a', 195_000), ['b', 'c'], 'b', t0 + 3000), 0);
});

test('skipping mid-song counts once', () => {
  assert.equal(countManualSkips(playing('a', 30_000), ['b', 'c'], 'b', t0 + 3000), 1);
});

test('a fast double-skip between polls counts twice', () => {
  assert.equal(countManualSkips(playing('a', 30_000), ['b', 'c', 'd'], 'c', t0 + 3000), 2);
});

test('paused songs do not advance the clock', () => {
  const paused = { ...playing('a', 30_000), isPlaying: false };
  assert.equal(countManualSkips(paused, ['b'], 'b', t0 + 600_000), 1);
});

test('no change, no skip', () => {
  assert.equal(countManualSkips(playing('a', 30_000), ['b'], 'a', t0 + 3000), 0);
  assert.equal(countManualSkips(null, ['b'], 'b', t0), 0);
});
