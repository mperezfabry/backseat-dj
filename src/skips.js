// A track that ends within this much of its natural end counts as finished, not skipped.
const NATURAL_END_TOLERANCE_MS = 8000;

/**
 * How many tracks did the driver skip to get from `prev` to `nowUri`?
 *
 * We only poll every few seconds, so a fast double-skip can show up as a single
 * change that jumps two places in the queue. `upcoming` is the queue as it looked
 * after `prev` started, which lets us count how far the jump went.
 *
 * @param prev     { uri, progressMs, durationMs, isPlaying, at } from the previous poll
 * @param upcoming URIs that were queued to play after prev
 * @param nowUri   URI playing now
 * @param now      timestamp of this poll
 */
export function countManualSkips(prev, upcoming, nowUri, now) {
  if (!prev?.uri || !nowUri || prev.uri === nowUri) return 0;
  const elapsed = prev.isPlaying ? now - prev.at : 0;
  const finishedNaturally = prev.durationMs - (prev.progressMs + elapsed) <= NATURAL_END_TOLERANCE_MS;
  const position = upcoming.indexOf(nowUri);
  // Not in the queue: the driver picked something else or hit "previous". Count it as one skip.
  if (position === -1) return finishedNaturally ? 0 : 1;
  return position + (finishedNaturally ? 0 : 1);
}
