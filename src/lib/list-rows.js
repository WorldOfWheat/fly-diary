// ---------------------------------------------------------------------------
// Virtual-list row model
// ---------------------------------------------------------------------------
//
// The sidebar mixes entry rows with month separators, so rows no longer all
// have the same height. These helpers build a flat, ordered row model with
// absolute offsets; `main.js` renders only the slice around the viewport, and
// the scroll math stays exact without measuring the DOM.

export function buildDisplayRows(entries, rowHeight, monthHeight) {
  const rows = [];
  const byDate = new Map();
  let top = 0;
  let month = "";

  for (const entry of entries) {
    const entryMonth = entry.date.slice(0, 7);
    if (entryMonth !== month) {
      rows.push({
        type: "month",
        month: entryMonth,
        top,
        height: monthHeight,
        index: rows.length,
      });
      top += monthHeight;
      month = entryMonth;
    }

    const row = {
      type: "entry",
      entry,
      top,
      height: rowHeight,
      index: rows.length,
    };
    rows.push(row);
    byDate.set(entry.date, row);
    top += rowHeight;
  }

  return { rows, byDate, height: top };
}

/** Index of the last row whose top is at or before `offset`. */
export function rowIndexAt(rows, offset) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid].top <= offset) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}

/** Unique years in descending order. */
export function yearsOf(entries) {
  const years = new Set();
  for (const entry of entries) years.add(entry.date.slice(0, 4));
  return [...years].sort((a, b) => b.localeCompare(a));
}

/**
 * First entry in `year`, plus the month header immediately above it (if any),
 * so a jump shows the month label rather than hiding it above the viewport.
 */
export function firstRowForYear(rows, year) {
  const prefix = `${year}-`;
  const index = rows.findIndex(
    (row) => row.type === "entry" && row.entry.date.startsWith(prefix)
  );
  if (index < 0) return null;
  const row = rows[index];
  const header =
    index > 0 && rows[index - 1].type === "month" ? rows[index - 1] : null;
  return { row, header };
}
