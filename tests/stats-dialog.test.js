// ---------------------------------------------------------------------------
// Statistics dialog tests
// ---------------------------------------------------------------------------
//
// `stats-dialog.js` is stateless: every `renderStats()` re-reads the entry list
// and rebuilds the DOM. The tests therefore focus on the mapping from entries to
// the four cards and the two bar charts, plus the empty-diary branch.
//
// The maths itself is covered by `tests/stats.test.js`; here we only check that
// the right numbers reach the right elements.

import test from "node:test";
import assert from "node:assert/strict";

import { createStatsDialog } from "../src/stats-dialog.js";
import { shiftDate, toISODate } from "../src/lib/dates.js";
import { installDom, fakeEls, fakeT, spy } from "./helpers/dom.js";

const STATS_IDS = [
  "statsOverlay",
  "statsDone",
  "statsTotal",
  "statsFavourites",
  "statsStreak",
  "statsLongest",
  "statsRange",
  "statsMonths",
  "statsWeekdays",
];

/** Build a stats controller plus the fakes it needs. */
function harness(overrides = {}) {
  const restore = installDom();
  const els = fakeEls(STATS_IDS);
  els.statsOverlay.hidden = true;

  const deps = {
    els,
    getEntries: () => [],
    t: fakeT(),
    formatDate: (iso) => `date:${iso}`,
    weekdayName: (day) => `wd:${day}`,
    ...overrides,
  };

  return {
    els,
    deps,
    stats: createStatsDialog(deps),
    restore,
  };
}

function withStats(body, overrides) {
  const h = harness(overrides);
  try {
    return body(h);
  } finally {
    h.restore();
  }
}

/** Three entries on consecutive days, newest first, one of them a favourite. */
const ENTRIES = [
  { date: "2026-10-23", favourite: true },
  { date: "2026-10-22", favourite: false },
  { date: "2026-10-21", favourite: false },
];

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

test("isStatsOpen reflects the overlay's hidden flag", () => {
  withStats(({ stats, els }) => {
    els.statsOverlay.hidden = true;
    assert.equal(stats.isStatsOpen(), false);

    els.statsOverlay.hidden = false;
    assert.equal(stats.isStatsOpen(), true);
  });
});

test("openStats renders and shows the dialog, then focuses Done", () => {
  withStats(
    ({ stats, els }) => {
      stats.openStats();

      assert.equal(els.statsOverlay.hidden, false);
      assert.equal(document.activeElement, els.statsDone);
      assert.equal(els.statsTotal.textContent, "3");
    },
    { getEntries: () => ENTRIES }
  );
});

test("closeStats hides the dialog", () => {
  withStats(({ stats, els }) => {
    els.statsOverlay.hidden = false;
    stats.closeStats();
    assert.equal(els.statsOverlay.hidden, true);
  });
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

test("renderStats fills the total and favourite counts", () => {
  withStats(
    ({ stats, els }) => {
      stats.renderStats();

      assert.equal(els.statsTotal.textContent, "3");
      assert.equal(els.statsFavourites.textContent, "1");
    },
    { getEntries: () => ENTRIES }
  );
});

test("renderStats reports the current and longest streaks", () => {
  // The streak maths reads the real clock, so build the fixture relative to
  // today instead of relying on the date the suite happens to run on.
  const today = toISODate(new Date());
  const entries = [
    { date: today, favourite: true },
    { date: shiftDate(today, -1), favourite: false },
    { date: shiftDate(today, -2), favourite: false },
  ];

  withStats(
    ({ stats, els }) => {
      stats.renderStats();

      // Three consecutive days ending today: both streaks are 3.
      assert.equal(els.statsStreak.textContent, "stats.days(n=3)");
      assert.equal(els.statsLongest.textContent, "stats.days(n=3)");
    },
    { getEntries: () => entries }
  );
});

test("renderStats shows the date range oldest to newest", () => {
  withStats(
    ({ stats, els }) => {
      stats.renderStats();

      assert.equal(
        els.statsRange.textContent,
        "stats.range(first=date:2026-10-21,last=date:2026-10-23)"
      );
    },
    { getEntries: () => ENTRIES }
  );
});

// ---------------------------------------------------------------------------
// Empty diary
// ---------------------------------------------------------------------------

test("renderStats shows an empty message and clears the charts", () => {
  withStats(({ stats, els }) => {
    stats.renderStats();

    assert.equal(els.statsTotal.textContent, "0");
    assert.equal(els.statsFavourites.textContent, "0");
    assert.equal(els.statsRange.textContent, "");

    // The month chart holds the empty message; the weekday chart is cleared.
    assert.equal(els.statsMonths.children.length, 1);
    assert.equal(els.statsMonths.children[0].className, "stats-empty");
    assert.equal(els.statsMonths.children[0].textContent, "stats.empty");
    assert.equal(els.statsWeekdays.children.length, 0);
  });
});

test("renderStats does not draw bars for an empty diary", () => {
  withStats(({ stats, els }) => {
    stats.renderStats();
    assert.equal(els.statsMonths.byClass("stats-bar").length, 0);
  });
});

// ---------------------------------------------------------------------------
// Bar charts
// ---------------------------------------------------------------------------

test("renderStats draws twelve month bars", () => {
  withStats(
    ({ stats, els }) => {
      stats.renderStats();

      const bars = els.statsMonths.byClass("stats-bar");
      assert.equal(bars.length, 12);
      assert.equal(els.statsMonths.className, "stats-chart");
    },
    { getEntries: () => ENTRIES }
  );
});

test("renderStats draws seven weekday bars with the weekday class", () => {
  withStats(
    ({ stats, els }) => {
      stats.renderStats();

      const bars = els.statsWeekdays.byClass("stats-bar");
      assert.equal(bars.length, 7);
      assert.equal(els.statsWeekdays.className, "stats-chart weekdays");
      assert.deepEqual(
        bars.map((bar) => bar.byClass("stats-bar-label")[0].textContent),
        ["wd:0", "wd:1", "wd:2", "wd:3", "wd:4", "wd:5", "wd:6"]
      );
    },
    { getEntries: () => ENTRIES }
  );
});

test("renderBarChart sets a relative height on each fill", () => {
  withStats(({ stats, els }) => {
    stats.renderBarChart(els.statsMonths, [
      { label: "a", count: 4, title: "four" },
      { label: "b", count: 2, title: "two" },
      { label: "c", count: 0, title: "zero" },
    ]);

    const fills = els.statsMonths.byClass("stats-bar-fill");
    assert.deepEqual(
      fills.map((fill) => fill.style.props.get("--v")),
      [1, 0.5, 0]
    );
  });
});

test("renderBarChart marks zero-count bars as empty", () => {
  withStats(({ stats, els }) => {
    stats.renderBarChart(els.statsMonths, [
      { label: "a", count: 1, title: "one" },
      { label: "b", count: 0, title: "zero" },
    ]);

    const fills = els.statsMonths.byClass("stats-bar-fill");
    assert.equal(fills[0].classList.contains("empty"), false);
    assert.equal(fills[1].classList.contains("empty"), true);
  });
});

test("renderBarChart puts the count in the bar's tooltip", () => {
  withStats(({ stats, els }) => {
    stats.renderBarChart(els.statsMonths, [
      { label: "a", count: 7, title: "seven entries" },
    ]);

    assert.equal(els.statsMonths.byClass("stats-bar")[0].title, "seven entries");
  });
});

test("renderBarChart replaces the previous chart", () => {
  withStats(({ stats, els }) => {
    stats.renderBarChart(els.statsMonths, [
      { label: "a", count: 1, title: "one" },
      { label: "b", count: 1, title: "one" },
    ]);
    stats.renderBarChart(els.statsMonths, [{ label: "c", count: 1, title: "one" }]);

    assert.equal(els.statsMonths.byClass("stats-bar").length, 1);
  });
});

test("renderBarChart drops the extra class when none is given", () => {
  withStats(({ stats, els }) => {
    els.statsMonths.className = "stats-chart weekdays";
    stats.renderBarChart(els.statsMonths, []);
    assert.equal(els.statsMonths.className, "stats-chart");
  });
});

test("renderBarChart handles an all-zero chart without dividing by zero", () => {
  withStats(({ stats, els }) => {
    stats.renderBarChart(els.statsMonths, [
      { label: "a", count: 0, title: "zero" },
      { label: "b", count: 0, title: "zero" },
    ]);

    const fills = els.statsMonths.byClass("stats-bar-fill");
    assert.deepEqual(
      fills.map((fill) => fill.style.props.get("--v")),
      [0, 0]
    );
  });
});

// ---------------------------------------------------------------------------
// Re-render
// ---------------------------------------------------------------------------

test("renderStats re-reads the entry list on every call", () => {
  const getEntries = spy(() => ENTRIES);
  withStats(
    ({ stats }) => {
      stats.renderStats();
      stats.renderStats();
      assert.equal(getEntries.count(), 2);
    },
    { getEntries }
  );
});

test("renderStats reflects a shrinking entry list", () => {
  let entries = ENTRIES;
  withStats(
    ({ stats, els }) => {
      stats.renderStats();
      assert.equal(els.statsTotal.textContent, "3");

      entries = [];
      stats.renderStats();
      assert.equal(els.statsTotal.textContent, "0");
      assert.equal(els.statsWeekdays.children.length, 0);
    },
    { getEntries: () => entries }
  );
});
