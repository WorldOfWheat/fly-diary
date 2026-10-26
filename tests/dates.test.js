import test from "node:test";
import assert from "node:assert/strict";

import {
  toISODate,
  fromISODate,
  shiftDate,
  monthStartOf,
  shiftMonth,
  daysBetween,
  calendarGrid,
} from "../src/lib/dates.js";

test("toISODate pads month and day", () => {
  assert.equal(toISODate(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(toISODate(new Date(2026, 11, 31)), "2026-12-31");
});

test("toISODate uses local time, not UTC", () => {
  // Midnight local must stay on the same calendar day even in timezones west
  // of UTC, where `toISOString()` would roll back a day.
  const d = new Date(2026, 9, 23, 0, 0, 0);
  assert.equal(toISODate(d), "2026-10-23");
});

test("fromISODate returns local midnight", () => {
  const d = fromISODate("2026-10-23");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 23);
  assert.equal(d.getHours(), 0);
});

test("fromISODate and toISODate roundtrip", () => {
  for (const iso of ["2024-02-29", "2026-01-01", "2026-12-31", "1999-07-04"]) {
    assert.equal(toISODate(fromISODate(iso)), iso);
  }
});

test("shiftDate crosses month and year boundaries", () => {
  assert.equal(shiftDate("2026-01-31", 1), "2026-02-01");
  assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDate("2026-01-01", -1), "2025-12-31");
});

test("shiftDate handles leap days", () => {
  assert.equal(shiftDate("2024-02-28", 1), "2024-02-29");
  assert.equal(shiftDate("2024-02-29", 1), "2024-03-01");
  assert.equal(shiftDate("2026-02-28", 1), "2026-03-01");
});

test("shiftDate by zero is the identity", () => {
  assert.equal(shiftDate("2026-10-23", 0), "2026-10-23");
});

test("monthStartOf truncates to the first", () => {
  assert.equal(monthStartOf("2026-10-23"), "2026-10-01");
  assert.equal(monthStartOf("2026-10-01"), "2026-10-01");
});

test("shiftMonth moves by whole months", () => {
  assert.equal(shiftMonth("2026-10-01", 1), "2026-11-01");
  assert.equal(shiftMonth("2026-10-01", -1), "2026-09-01");
  assert.equal(shiftMonth("2026-01-01", -1), "2025-12-01");
  assert.equal(shiftMonth("2026-12-01", 1), "2027-01-01");
  assert.equal(shiftMonth("2026-10-01", 12), "2027-10-01");
  assert.equal(shiftMonth("2026-10-01", -12), "2025-10-01");
});

test("daysBetween counts whole days", () => {
  assert.equal(daysBetween("2026-10-23", "2026-10-23"), 0);
  assert.equal(daysBetween("2026-10-23", "2026-10-24"), 1);
  assert.equal(daysBetween("2026-10-24", "2026-10-23"), -1);
  assert.equal(daysBetween("2026-01-01", "2026-12-31"), 364);
});

test("daysBetween is exact across a DST boundary", () => {
  // In most northern-hemisphere zones one of these spans is 23 or 25 hours;
  // rounding must still report a single day.
  assert.equal(daysBetween("2026-03-28", "2026-03-29"), 1);
  assert.equal(daysBetween("2026-10-24", "2026-10-25"), 1);
  assert.equal(daysBetween("2026-03-01", "2026-04-01"), 31);
});

test("calendarGrid always returns 42 cells", () => {
  for (const month of ["2026-01-01", "2026-02-01", "2026-11-01", "2024-02-01"]) {
    assert.equal(calendarGrid(month).length, 42);
  }
});

test("calendarGrid starts on a Monday", () => {
  for (const month of ["2026-01-01", "2026-10-01", "2026-11-01"]) {
    const first = fromISODate(calendarGrid(month)[0]);
    assert.equal(first.getDay(), 1, `${month} should start on Monday`);
  }
});

test("calendarGrid contains every day of the month exactly once", () => {
  const cells = calendarGrid("2026-10-01");
  const inMonth = cells.filter((iso) => iso.startsWith("2026-10"));
  assert.equal(inMonth.length, 31);
  assert.equal(new Set(cells).size, 42);
  assert.equal(inMonth[0], "2026-10-01");
  assert.equal(inMonth[inMonth.length - 1], "2026-10-31");
});

test("calendarGrid pads with neighbouring months", () => {
  // 2026-10-01 is a Thursday, so the grid starts on 2026-09-28.
  const cells = calendarGrid("2026-10-01");
  assert.equal(cells[0], "2026-09-28");
  assert.equal(cells[41], "2026-11-08");
});

test("calendarGrid handles a month starting on Monday", () => {
  // 2026-06-01 is a Monday: no leading padding at all.
  const cells = calendarGrid("2026-06-01");
  assert.equal(cells[0], "2026-06-01");
});

test("calendarGrid handles a month starting on Sunday", () => {
  // 2026-11-01 is a Sunday: six leading days from October.
  const cells = calendarGrid("2026-11-01");
  assert.equal(cells[0], "2026-10-26");
  assert.equal(cells[6], "2026-11-01");
});

test("calendarGrid handles February in a leap year", () => {
  const cells = calendarGrid("2024-02-01");
  const inMonth = cells.filter((iso) => iso.startsWith("2024-02"));
  assert.equal(inMonth.length, 29);
  assert.ok(inMonth.includes("2024-02-29"));
});
