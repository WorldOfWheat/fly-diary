// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
//
// Every date in this app is a local calendar day, never a UTC instant: the
// diary decides "today" in the user's timezone, so a UTC-based helper would
// disagree with the entry list around midnight. These functions are pure and
// have no DOM or Tauri dependency, which is what lets `tests/dates.test.js`
// exercise them directly under `node --test`.

/** Format a `Date` as `YYYY-MM-DD` in local time. */
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse `YYYY-MM-DD` into a local `Date` at midnight. */
export function fromISODate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Shift an ISO date string by `days`. */
export function shiftDate(iso, days) {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** `2026-10-23` → `2026-10-01`. */
export function monthStartOf(iso) {
  return `${iso.slice(0, 7)}-01`;
}

/** Shift a `YYYY-MM-01` string by `months`, clamped to the 1st. */
export function shiftMonth(monthStart, months) {
  const [y, m] = monthStart.split("-").map(Number);
  const d = new Date(y, m - 1 + months, 1);
  return toISODate(d);
}

/**
 * Whole days between two ISO dates (`b - a`).
 *
 * `Math.round` absorbs the one-hour drift that a daylight-saving boundary
 * introduces, so a 23- or 25-hour "day" still counts as exactly one.
 */
export function daysBetween(a, b) {
  return Math.round((fromISODate(b).getTime() - fromISODate(a).getTime()) / 86400000);
}

/**
 * The 42 cells (6 weeks, Monday first) of the month containing `monthStart`.
 *
 * Returns ISO strings, including the leading/trailing days of the neighbouring
 * months that fill out the grid. Monday-first because `getDay()` is
 * Sunday-based, hence the `+ 6) % 7` shift.
 */
export function calendarGrid(monthStart) {
  const [year, month] = monthStart.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month - 1, 1 - lead);

  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    cells.push(
      toISODate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
    );
  }
  return cells;
}
