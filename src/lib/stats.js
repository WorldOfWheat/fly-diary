// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
//
// Everything here is derived from the entry metadata the sidebar already holds
// (`date`, `title`, `size`, `favourite`), so opening the statistics dialog
// costs no backend call. The functions are pure — `today` is injected rather
// than read from the clock — so the tests can pin a date and stay deterministic.

import { fromISODate, shiftDate, toISODate } from "./dates.js";

/** Today as `YYYY-MM-DD` in local time. */
function localToday() {
  return toISODate(new Date());
}

/**
 * Longest and current run of consecutive days.
 *
 * `today` defaults to the real local date; tests pass it explicitly.
 *
 * The current streak counts back from today. A day that has not been written
 * yet must not break it, so when today is empty the count starts from
 * yesterday instead — otherwise every streak would read 0 until the user
 * wrote something that day.
 */
export function computeStreaks(entries, today = localToday()) {
  if (entries.length === 0) return { current: 0, longest: 0 };

  const days = entries
    .map((e) => fromISODate(e.date).getTime())
    .sort((a, b) => a - b);

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    // `Math.round` absorbs the one-hour drift on daylight-saving boundaries.
    const diff = Math.round((days[i] - days[i - 1]) / 86400000);
    run = diff === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const written = new Set(entries.map((e) => e.date));
  let cursor = today;
  if (!written.has(cursor)) cursor = shiftDate(cursor, -1);

  let current = 0;
  while (written.has(cursor)) {
    current++;
    cursor = shiftDate(cursor, -1);
  }

  return { current, longest };
}

/**
 * Bucket entries into the last `count` months, oldest first.
 *
 * Each bucket is `{ key: "YYYY-MM", month: 1-12, count }`. Entries outside the
 * window are ignored rather than clamped into the edge buckets.
 */
export function monthlyBuckets(entries, count, today = localToday()) {
  const [year, month] = today.split("-").map(Number);
  const buckets = [];
  for (let i = count - 1; i >= 0; i--) {
    // `Date` normalises month overflow, so `month - 1 - i` may be negative.
    const d = new Date(year, month - 1 - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    buckets.push({ key, month: d.getMonth() + 1, count: 0 });
  }

  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const entry of entries) {
    const bucket = byKey.get(entry.date.slice(0, 7));
    if (bucket) bucket.count++;
  }
  return buckets;
}

/** Count entries per weekday, Sunday first to match `weekdayName()`. */
export function weekdayBuckets(entries) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const entry of entries) {
    counts[fromISODate(entry.date).getDay()]++;
  }
  return counts;
}

/**
 * Relative height of each bar, as a 0..1 fraction of the tallest bucket.
 *
 * An all-zero series returns all zeros, which the stylesheet renders as flat
 * stubs rather than dividing by zero.
 */
export function barFractions(counts) {
  const max = Math.max(...counts, 0);
  return counts.map((count) => (max === 0 ? 0 : count / max));
}
