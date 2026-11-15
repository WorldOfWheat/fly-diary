import test from "node:test";
import assert from "node:assert/strict";

import { historyItems, HISTORY_OFFSETS } from "../src/lib/history.js";

const CURRENT = "2026-11-15";

function mapOf(entries) {
  return new Map(entries.map((entry) => [entry.date, entry]));
}

test("offsets are one month, six months, one year, three years and five years", () => {
  assert.deepEqual(
    HISTORY_OFFSETS.map((offset) => offset.months),
    [-1, -6, -12, -36, -60]
  );
});

test("builds cards for each anchor that has an entry", () => {
  const entries = mapOf([
    { date: "2026-10-15", title: "last month", favourite: true },
    { date: "2026-05-15", title: "six months" },
    { date: "2025-11-15", title: "last year" },
    { date: "2023-11-15", title: "three years" },
    { date: "2021-11-15", title: "five years" },
  ]);

  const items = historyItems(CURRENT, entries, new Map());

  assert.deepEqual(items, [
    {
      date: "2026-10-15",
      offsetKey: "history.oneMonth",
      title: "last month",
      favourite: true,
      broken: false,
    },
    {
      date: "2026-05-15",
      offsetKey: "history.sixMonths",
      title: "six months",
      favourite: false,
      broken: false,
    },
    {
      date: "2025-11-15",
      offsetKey: "history.oneYear",
      title: "last year",
      favourite: false,
      broken: false,
    },
    {
      date: "2023-11-15",
      offsetKey: "history.threeYears",
      title: "three years",
      favourite: false,
      broken: false,
    },
    {
      date: "2021-11-15",
      offsetKey: "history.fiveYears",
      title: "five years",
      favourite: false,
      broken: false,
    },
  ]);
});

test("shows at most five cards", () => {
  const entries = mapOf(
    [
      "2026-10-15",
      "2026-05-15",
      "2025-11-15",
      "2023-11-15",
      "2021-11-15",
    ].map((date) => ({ date, title: date }))
  );

  const items = historyItems(CURRENT, entries, new Map());

  assert.equal(items.length, 5);
  assert.deepEqual(
    items.map((item) => item.offsetKey),
    [
      "history.oneMonth",
      "history.sixMonths",
      "history.oneYear",
      "history.threeYears",
      "history.fiveYears",
    ]
  );
});

test("skips anchors with no entry", () => {
  const entries = mapOf([{ date: "2026-05-15", title: "six months" }]);

  assert.deepEqual(
    historyItems(CURRENT, entries, new Map()).map((item) => item.offsetKey),
    ["history.sixMonths"]
  );
});

test("includes a broken file even though it is not in the index", () => {
  const entries = mapOf([]);
  const broken = new Map([["2026-10-15", { reason: "decrypt" }]]);

  const items = historyItems(CURRENT, entries, broken);

  assert.equal(items.length, 1);
  assert.equal(items[0].date, "2026-10-15");
  assert.equal(items[0].title, "");
  assert.equal(items[0].broken, true);
});

test("a readable entry wins over a stale broken marker", () => {
  const entries = mapOf([{ date: "2026-10-15", title: "readable" }]);
  const broken = new Map([["2026-10-15", { reason: "stale" }]]);

  const items = historyItems(CURRENT, entries, broken);

  assert.equal(items[0].broken, false);
  assert.equal(items[0].title, "readable");
});

test("returns nothing without a current date", () => {
  assert.deepEqual(historyItems("", new Map(), new Map()), []);
});

test("returns nothing for a malformed date", () => {
  assert.deepEqual(historyItems("not-a-date", new Map(), new Map()), []);
});

test("clamps the day when an earlier month is shorter", () => {
  const entries = mapOf([
    { date: "2026-02-28", title: "one month" },
    { date: "2025-09-30", title: "six months" },
    { date: "2025-03-31", title: "one year" },
  ]);

  const items = historyItems("2026-03-31", entries, new Map());

  assert.deepEqual(
    items.map((item) => [item.date, item.offsetKey]),
    [
      ["2026-02-28", "history.oneMonth"],
      ["2025-09-30", "history.sixMonths"],
      ["2025-03-31", "history.oneYear"],
    ]
  );
});

test("clamps a leap day when the earlier year is not a leap year", () => {
  const entries = mapOf([
    { date: "2023-02-28", title: "one year" },
    { date: "2021-02-28", title: "three years" },
    { date: "2019-02-28", title: "five years" },
  ]);

  const items = historyItems("2024-02-29", entries, new Map());

  assert.deepEqual(
    items.map((item) => [item.date, item.offsetKey]),
    [
      ["2023-02-28", "history.oneYear"],
      ["2021-02-28", "history.threeYears"],
      ["2019-02-28", "history.fiveYears"],
    ]
  );
});
