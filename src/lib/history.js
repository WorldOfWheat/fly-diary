// ---------------------------------------------------------------------------
// "On this day" review cards
// ---------------------------------------------------------------------------
//
// The sidebar already holds every entry's date and title, so the review strip
// can be computed entirely on the frontend: no extra IPC, no extra decryption,
// and nothing new to persist. The offsets are relative to the date currently
// being viewed, which makes the same widget useful outside today as well.

import { shiftMonthsClamped } from "./dates.js";

/** The look-back anchors shown above the editor, most recent first. */
export const HISTORY_OFFSETS = [
  { months: -1, key: "history.oneMonth" },
  { months: -6, key: "history.sixMonths" },
  { months: -12, key: "history.oneYear" },
  { months: -36, key: "history.threeYears" },
  { months: -60, key: "history.fiveYears" },
];

/**
 * Build the cards for one date.
 *
 * @param {string} currentDate `YYYY-MM-DD` currently open in the editor.
 * @param {Map<string, { title?: string, favourite?: boolean }>} entriesByDate
 * @param {Map<string, unknown>} brokenByDate
 * @returns {Array<{
 *   date: string,
 *   offsetKey: string,
 *   title: string,
 *   favourite: boolean,
 *   broken: boolean
 * }>}
 */
export function historyItems(currentDate, entriesByDate, brokenByDate) {
  if (!currentDate || !entriesByDate) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) return [];

  const items = [];
  for (const { months, key } of HISTORY_OFFSETS) {
    const date = shiftMonthsClamped(currentDate, months);
    const entry = entriesByDate.get(date);
    const broken = !entry && Boolean(brokenByDate?.has(date));
    if (!entry && !broken) continue;
    items.push({
      date,
      offsetKey: key,
      title: entry?.title || "",
      favourite: Boolean(entry?.favourite),
      broken,
    });
  }
  return items;
}
