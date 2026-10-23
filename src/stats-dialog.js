// ---------------------------------------------------------------------------
// Statistics dialog
// ---------------------------------------------------------------------------
//
// Everything here is derived from the entry metadata the sidebar already holds:
// date, title, size and the favourite flag. No extra backend call is needed, and
// nothing is cached, so locking the diary (which clears the entry list) cannot
// leave stale numbers on screen.
//
// The maths lives in `lib/stats.js`; this module only touches the DOM.
//
// `deps` shape:
//
//   els            — the lookup table from `dom.js`
//   getEntries     — () => Array<{ date, favourite }>
//   t              — (key: string, params?: object) => string
//   formatDate     — (iso: string) => string
//   weekdayName    — (dayIndex: number) => string

import {
  barFractions,
  computeStreaks,
  monthlyBuckets,
  weekdayBuckets,
} from "./lib/stats.js";

/**
 * Create the statistics dialog controller.
 *
 * Returns the functions `main.js` and `wiring.js` need. The dialog holds no
 * state of its own: every open re-reads the entry list.
 */
export function createStatsDialog(deps) {
  const { els } = deps;

  /** Whether the statistics dialog is open. */
  function isStatsOpen() {
    return !els.statsOverlay.hidden;
  }

  /**
   * Render one bar chart.
   *
   * `items` is `[{ label, count, title }]`. Heights are relative to the tallest
   * bucket so a quiet month still shows a readable shape; an all-zero chart
   * falls back to a flat row of stubs.
   */
  function renderBarChart(container, items, extraClass) {
    container.replaceChildren();
    container.className = "stats-chart" + (extraClass ? ` ${extraClass}` : "");

    const fractions = barFractions(items.map((item) => item.count));
    items.forEach((item, index) => {
      const bar = document.createElement("div");
      bar.className = "stats-bar";
      bar.title = item.title;

      const fill = document.createElement("div");
      fill.className = "stats-bar-fill" + (item.count === 0 ? " empty" : "");
      fill.style.setProperty("--v", fractions[index]);

      const label = document.createElement("span");
      label.className = "stats-bar-label";
      label.textContent = item.label;

      bar.append(fill, label);
      container.append(bar);
    });
  }

  /** Fill the dialog from the entry list. */
  function renderStats() {
    const allEntries = deps.getEntries();
    const total = allEntries.length;
    els.statsTotal.textContent = String(total);
    els.statsFavourites.textContent = String(
      allEntries.filter((e) => e.favourite).length
    );

    const { current, longest } = computeStreaks(allEntries);
    els.statsStreak.textContent = deps.t("stats.days", { n: current });
    els.statsLongest.textContent = deps.t("stats.days", { n: longest });

    if (total === 0) {
      els.statsRange.textContent = "";
      els.statsMonths.replaceChildren();
      els.statsWeekdays.replaceChildren();

      const empty = document.createElement("p");
      empty.className = "stats-empty";
      empty.textContent = deps.t("stats.empty");
      els.statsMonths.append(empty);
      return;
    }

    // The list is newest first, so the last element is the oldest entry.
    els.statsRange.textContent = deps.t("stats.range", {
      first: deps.formatDate(allEntries[total - 1].date),
      last: deps.formatDate(allEntries[0].date),
    });

    renderBarChart(
      els.statsMonths,
      monthlyBuckets(allEntries, 12).map((bucket) => ({
        label: deps.t("stats.monthLabel", { month: bucket.month }),
        count: bucket.count,
        title: deps.t("stats.count", { n: bucket.count }),
      }))
    );

    renderBarChart(
      els.statsWeekdays,
      weekdayBuckets(allEntries).map((count, day) => ({
        label: deps.weekdayName(day),
        count,
        title: deps.t("stats.count", { n: count }),
      })),
      "weekdays"
    );
  }

  /** Open the statistics dialog. */
  function openStats() {
    renderStats();
    els.statsOverlay.hidden = false;
    els.statsDone.focus();
  }

  /** Close the statistics dialog. */
  function closeStats() {
    els.statsOverlay.hidden = true;
  }

  return { renderBarChart, renderStats, openStats, closeStats, isStatsOpen };
}
