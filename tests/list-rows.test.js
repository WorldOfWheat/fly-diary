import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDisplayRows,
  rowIndexAt,
  yearsOf,
  firstRowForYear,
} from "../src/lib/list-rows.js";

const ENTRY_H = 50;
const MONTH_H = 20;

function entries(...dates) {
  return dates.map((date) => ({ date, title: date }));
}

test("inserts one month header before the first entry of each month", () => {
  const { rows, height, byDate } = buildDisplayRows(
    entries("2026-11-15", "2026-11-02", "2026-10-31", "2025-12-01"),
    ENTRY_H,
    MONTH_H
  );

  assert.deepEqual(
    rows.map((row) => (row.type === "month" ? row.month : row.entry.date)),
    ["2026-11", "2026-11-15", "2026-11-02", "2026-10", "2026-10-31", "2025-12", "2025-12-01"]
  );
  assert.deepEqual(
    rows.map((row) => row.top),
    [0, 20, 70, 120, 140, 190, 210]
  );
  assert.equal(height, 260);
  assert.equal(byDate.get("2026-10-31").top, 140);
});

test("an empty list has no rows and no height", () => {
  const model = buildDisplayRows([], ENTRY_H, MONTH_H);

  assert.deepEqual(model.rows, []);
  assert.equal(model.height, 0);
  assert.equal(model.byDate.size, 0);
});

test("search results with gaps still get a header per represented month", () => {
  const { rows } = buildDisplayRows(
    entries("2026-01-10", "2024-06-04"),
    ENTRY_H,
    MONTH_H
  );

  assert.deepEqual(
    rows.map((row) => (row.type === "month" ? row.month : row.entry.date)),
    ["2026-01", "2026-01-10", "2024-06", "2024-06-04"]
  );
});

test("rowIndexAt finds the row containing an offset", () => {
  const { rows } = buildDisplayRows(
    entries("2026-11-15", "2026-10-31"),
    ENTRY_H,
    MONTH_H
  );

  assert.equal(rowIndexAt(rows, 0), 0);
  assert.equal(rowIndexAt(rows, 19), 0);
  assert.equal(rowIndexAt(rows, 20), 1);
  assert.equal(rowIndexAt(rows, 69), 1);
  assert.equal(rowIndexAt(rows, 70), 2);
  assert.equal(rowIndexAt(rows, 9999), rows.length - 1);
  assert.equal(rowIndexAt([], 10), 0);
});

test("yearsOf returns unique years newest first", () => {
  assert.deepEqual(
    yearsOf(
      entries(
        "2026-11-15",
        "2024-01-01",
        "2026-01-01",
        "2025-05-05",
        "2024-12-31"
      )
    ),
    ["2026", "2025", "2024"]
  );
  assert.deepEqual(yearsOf([]), []);
});

test("firstRowForYear includes the month header above the entry", () => {
  const { rows } = buildDisplayRows(
    entries("2026-11-15", "2026-10-31", "2025-01-01"),
    ENTRY_H,
    MONTH_H
  );

  const hit = firstRowForYear(rows, "2026");
  assert.equal(hit.row.entry.date, "2026-11-15");
  assert.equal(hit.header.month, "2026-11");

  const older = firstRowForYear(rows, "2025");
  assert.equal(older.row.entry.date, "2025-01-01");
  assert.equal(older.header.month, "2025-01");

  assert.equal(firstRowForYear(rows, "2024"), null);
});
