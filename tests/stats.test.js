import test from "node:test";
import assert from "node:assert/strict";

import {
  computeStreaks,
  monthlyBuckets,
  weekdayBuckets,
  barFractions,
} from "../src/lib/stats.js";

/** Build the minimal metadata shape the stats functions read. */
const entry = (date, favourite = false) => ({ date, favourite });

test("computeStreaks on an empty list", () => {
  assert.deepEqual(computeStreaks([], "2026-10-23"), { current: 0, longest: 0 });
});

test("computeStreaks with only today written", () => {
  assert.deepEqual(computeStreaks([entry("2026-10-23")], "2026-10-23"), {
    current: 1,
    longest: 1,
  });
});

test("computeStreaks counts a run ending today", () => {
  const entries = [
    entry("2026-10-23"),
    entry("2026-10-22"),
    entry("2026-10-21"),
    entry("2026-10-20"),
    entry("2026-10-19"),
  ];
  assert.deepEqual(computeStreaks(entries, "2026-10-23"), {
    current: 5,
    longest: 5,
  });
});

test("computeStreaks keeps the current streak alive when today is unwritten", () => {
  // Yesterday and the two days before it: the streak is 3, not 0.
  const entries = [
    entry("2026-10-22"),
    entry("2026-10-21"),
    entry("2026-10-20"),
  ];
  assert.deepEqual(computeStreaks(entries, "2026-10-23"), {
    current: 3,
    longest: 3,
  });
});

test("computeStreaks reports 0 current when the last entry is older than yesterday", () => {
  const entries = [entry("2026-10-20"), entry("2026-10-19")];
  assert.deepEqual(computeStreaks(entries, "2026-10-23"), {
    current: 0,
    longest: 2,
  });
});

test("computeStreaks finds the longest run in the middle of the history", () => {
  const entries = [
    entry("2026-10-23"),
    entry("2026-10-22"),
    // gap on 2026-10-21
    entry("2026-10-20"),
    entry("2026-10-19"),
    entry("2026-10-18"),
    entry("2026-10-17"),
  ];
  assert.deepEqual(computeStreaks(entries, "2026-10-23"), {
    current: 2,
    longest: 4,
  });
});

test("computeStreaks ignores input order", () => {
  const ascending = [
    entry("2026-10-19"),
    entry("2026-10-20"),
    entry("2026-10-21"),
  ];
  const descending = [...ascending].reverse();
  assert.deepEqual(
    computeStreaks(ascending, "2026-10-21"),
    computeStreaks(descending, "2026-10-21")
  );
});

test("computeStreaks spans a month boundary", () => {
  const entries = [entry("2026-10-31"), entry("2026-11-01"), entry("2026-11-02")];
  assert.deepEqual(computeStreaks(entries, "2026-11-02"), {
    current: 3,
    longest: 3,
  });
});

test("computeStreaks spans a year boundary", () => {
  const entries = [entry("2025-12-31"), entry("2026-01-01")];
  assert.deepEqual(computeStreaks(entries, "2026-01-01"), {
    current: 2,
    longest: 2,
  });
});

test("computeStreaks spans a leap day", () => {
  const entries = [entry("2024-02-28"), entry("2024-02-29"), entry("2024-03-01")];
  assert.deepEqual(computeStreaks(entries, "2024-03-01"), {
    current: 3,
    longest: 3,
  });
});

test("computeStreaks treats a duplicate date as one day", () => {
  // Duplicates cannot happen through the UI, but a corrupt index could produce
  // them and must not inflate the count.
  const entries = [entry("2026-10-23"), entry("2026-10-23")];
  assert.deepEqual(computeStreaks(entries, "2026-10-23"), {
    current: 1,
    longest: 1,
  });
});

test("computeStreaks counts a single old entry as longest 1", () => {
  assert.deepEqual(computeStreaks([entry("2020-01-01")], "2026-10-23"), {
    current: 0,
    longest: 1,
  });
});

test("monthlyBuckets returns the requested number of buckets, oldest first", () => {
  const buckets = monthlyBuckets([], 12, "2026-10-23");
  assert.equal(buckets.length, 12);
  assert.equal(buckets[0].key, "2025-11");
  assert.equal(buckets[11].key, "2026-10");
  assert.equal(buckets[11].month, 10);
});

test("monthlyBuckets counts entries into the right month", () => {
  const entries = [
    entry("2026-10-01"),
    entry("2026-10-31"),
    entry("2026-09-15"),
  ];
  const buckets = monthlyBuckets(entries, 3, "2026-10-23");
  assert.deepEqual(
    buckets.map((b) => [b.key, b.count]),
    [
      ["2026-08", 0],
      ["2026-09", 1],
      ["2026-10", 2],
    ]
  );
});

test("monthlyBuckets ignores entries outside the window", () => {
  const entries = [entry("2020-01-01"), entry("2026-10-23")];
  const buckets = monthlyBuckets(entries, 2, "2026-10-23");
  assert.deepEqual(
    buckets.map((b) => b.count),
    [0, 1]
  );
});

test("monthlyBuckets crosses the year boundary", () => {
  const buckets = monthlyBuckets([], 3, "2026-01-15");
  assert.deepEqual(
    buckets.map((b) => b.key),
    ["2025-11", "2025-12", "2026-01"]
  );
});

test("monthlyBuckets with count 1 is just the current month", () => {
  const buckets = monthlyBuckets([entry("2026-10-05")], 1, "2026-10-23");
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].key, "2026-10");
  assert.equal(buckets[0].count, 1);
});

test("weekdayBuckets is Sunday-first and sums to the entry count", () => {
  // 2026-10-23 is a Friday (index 5), 2026-10-25 a Sunday (index 0).
  const entries = [entry("2026-10-23"), entry("2026-10-25"), entry("2026-10-23")];
  const counts = weekdayBuckets(entries);
  assert.equal(counts.length, 7);
  assert.equal(counts[5], 2);
  assert.equal(counts[0], 1);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    3
  );
});

test("weekdayBuckets on an empty list is all zeros", () => {
  assert.deepEqual(weekdayBuckets([]), [0, 0, 0, 0, 0, 0, 0]);
});

test("barFractions scales against the tallest bar", () => {
  assert.deepEqual(barFractions([1, 2, 4]), [0.25, 0.5, 1]);
});

test("barFractions returns all zeros for an all-zero series", () => {
  assert.deepEqual(barFractions([0, 0, 0]), [0, 0, 0]);
});

test("barFractions on an empty series", () => {
  assert.deepEqual(barFractions([]), []);
});

test("barFractions keeps zero bars at zero", () => {
  assert.deepEqual(barFractions([0, 5]), [0, 1]);
});
