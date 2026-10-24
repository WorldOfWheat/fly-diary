// ---------------------------------------------------------------------------
// Calendar overlay tests
// ---------------------------------------------------------------------------
//
// `calendar.js` owns the month cursor and the 6×7 grid. The tests drive it with
// a fake `els` table and a fixed "today", so the assertions do not depend on the
// day the suite happens to run.
//
// The interesting behaviour is the state machine around the overlay: which
// month it opens on, what the grid marks, how the month summary counts, and how
// keyboard navigation wraps across a month boundary.

import test from "node:test";
import assert from "node:assert/strict";

import { createCalendar } from "../src/calendar.js";
import { installDom, fakeEls, fakeT, spy } from "./helpers/dom.js";

const CAL_IDS = [
  "calendar",
  "calendarBackdrop",
  "calClose",
  "calTitle",
  "calMonth",
  "calSummary",
  "calWeekdays",
  "calGrid",
  "dateLabel",
];

/** A fixed "today" so the `.today` marker is deterministic. */
const TODAY = "2026-10-23";

/**
 * Run `body` with the global clock frozen at `TODAY`.
 *
 * `calendar.js` calls `toISODate(new Date())` to find "today", and that helper
 * is imported rather than injected. Freezing `Date` is therefore the only way
 * to make the `.today` marker deterministic without faking a dependency that
 * production does not pass — which is exactly the mistake that let a real
 * `deps.toISODate is not a function` crash slip past this suite.
 */
function withFrozenClock(body) {
  const RealDate = globalThis.Date;
  const frozen = new RealDate(`${TODAY}T12:00:00Z`);

  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(frozen.getTime());
      else super(...args);
    }
    static now() {
      return frozen.getTime();
    }
  }

  globalThis.Date = FrozenDate;
  try {
    return body();
  } finally {
    globalThis.Date = RealDate;
  }
}

/**
 * Build a calendar controller plus the fakes it needs.
 *
 * `formatMonth`/`formatDate`/`weekdayName` are stubs that echo their input, so
 * assertions can check which value reached the DOM without depending on the
 * locale dictionaries.
 */
function harness(overrides = {}) {
  const restore = installDom();
  const els = fakeEls(CAL_IDS);
  els.calendar.hidden = true;

  // `toISODate` is deliberately *not* injected: `calendar.js` imports it from
  // `lib/dates.js`, and stubbing it here once hid a real crash — production
  // never passed it, so `deps.toISODate` was undefined and opening the overlay
  // threw. The harness must mirror the real `deps` shape, not a superset.
  const deps = {
    els,
    getCurrentDate: () => TODAY,
    selectDate: spy(),
    getEntries: () => [],
    formatMonth: (monthStart) => `month:${monthStart}`,
    formatDate: (iso) => `date:${iso}`,
    weekdayName: (day) => `wd:${day}`,
    t: fakeT(),
    ...overrides,
  };

  const calendar = createCalendar(deps);

  return {
    els,
    deps,
    calendar,
    restore,
    /** The rendered day buttons, in grid order. */
    cells: () => els.calGrid.children,
    /** The `data-date` of every rendered cell. */
    dates: () => els.calGrid.children.map((cell) => cell.dataset.date),
  };
}

/**
 * Run `body` with a fresh harness, always restoring the DOM globals.
 *
 * The clock is frozen for the duration so `toISODate(new Date())` inside
 * `renderCalendar` agrees with `TODAY`.
 */
function withCalendar(body, overrides) {
  return withFrozenClock(() => {
    const h = harness(overrides);
    try {
      return body(h);
    } finally {
      h.restore();
    }
  });
}

// ---------------------------------------------------------------------------
// Weekday header
// ---------------------------------------------------------------------------

test("renderWeekdayHeaders fills seven spans, Monday first", () => {
  withCalendar(({ els, deps }) => {
    deps.weekdayName = (day) => `wd:${day}`;
    const calendar = createCalendar(deps);
    calendar.renderWeekdayHeaders();

    const spans = els.calWeekdays.children;
    assert.equal(spans.length, 7);
    // `getDay()` is Sunday-based, so the grid walks 1..6 then 0.
    assert.deepEqual(
      spans.map((span) => span.textContent),
      ["wd:1", "wd:2", "wd:3", "wd:4", "wd:5", "wd:6", "wd:0"]
    );
  });
});

test("renderWeekdayHeaders is a no-op when the header element is missing", () => {
  withCalendar(({ deps }) => {
    deps.els.calWeekdays = null;
    const calendar = createCalendar(deps);
    // Must not throw.
    calendar.renderWeekdayHeaders();
  });
});

// ---------------------------------------------------------------------------
// Grid rendering
// ---------------------------------------------------------------------------

test("renderCalendar draws a 6x7 grid for the visible month", () => {
  withCalendar(({ calendar, cells, dates }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();

    assert.equal(cells().length, 42);
    // The grid starts on the Monday on or before the 1st.
    assert.equal(dates()[0], "2026-09-28");
    assert.equal(dates()[41], "2026-11-08");
  });
});

test("renderCalendar writes the formatted month into the title", () => {
  withCalendar(({ calendar, els }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();
    assert.equal(els.calTitle.textContent, "month:2026-10-01");
  });
});

test("renderCalendar writes the formatted month into the stepper label", () => {
  withCalendar(({ calendar, els }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();
    assert.equal(els.calMonth.textContent, "month:2026-10-01");
  });
});

test("renderCalendar tolerates a missing stepper label", () => {
  withCalendar(({ calendar, deps }) => {
    deps.els.calMonth = null;
    const fresh = createCalendar(deps);
    fresh.setCalendarMonth("2026-10-01");
    // Must not throw.
    fresh.renderCalendar();
  });
});

// ---------------------------------------------------------------------------
// Month summary
// ---------------------------------------------------------------------------

test("renderCalendar counts the days with an entry in the visible month", () => {
  withCalendar(
    ({ calendar, els }) => {
      calendar.setCalendarMonth("2026-10-01");
      calendar.renderCalendar();
      assert.equal(
        els.calSummary.textContent,
        "editor.calSummary(month=month:2026-10-01,n=2)"
      );
    },
    {
      getEntries: () => [
        { date: "2026-10-02" },
        { date: "2026-10-23" },
        // Outside the month: must not inflate the count.
        { date: "2026-09-30" },
        { date: "2026-11-01" },
      ],
    }
  );
});

test("renderCalendar says so when the month has no entries", () => {
  withCalendar(({ calendar, els }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();
    assert.equal(
      els.calSummary.textContent,
      "editor.calSummaryEmpty(month=month:2026-10-01)"
    );
  });
});

test("renderCalendar tolerates a missing summary element", () => {
  withCalendar(({ deps }) => {
    deps.els.calSummary = null;
    const fresh = createCalendar(deps);
    fresh.setCalendarMonth("2026-10-01");
    // Must not throw.
    fresh.renderCalendar();
  });
});

test("renderCalendar marks days outside the visible month", () => {
  withCalendar(({ calendar, els }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();

    const outside = els.calGrid.byClass("outside");
    // September 28-30 and November 1-8 fall outside October.
    assert.equal(outside.length, 3 + 8);
    assert.ok(
      outside.every((cell) => !cell.dataset.date.startsWith("2026-10"))
    );
  });
});

test("renderCalendar marks today, the selected day and days with entries", () => {
  withCalendar(
    ({ calendar, els }) => {
      calendar.setCalendarMonth("2026-10-01");
      calendar.renderCalendar();

      const today = els.calGrid.byClass("today");
      assert.equal(today.length, 1);
      assert.equal(today[0].dataset.date, TODAY);

      const selected = els.calGrid.byClass("selected");
      assert.equal(selected.length, 1);
      assert.equal(selected[0].dataset.date, TODAY);
      assert.equal(selected[0].getAttribute("aria-selected"), "true");

      const withEntry = els.calGrid.byClass("has-entry");
      assert.deepEqual(
        withEntry.map((cell) => cell.dataset.date),
        ["2026-10-02", "2026-10-23"]
      );
    },
    {
      getEntries: () => [
        { date: "2026-10-02" },
        { date: "2026-10-23" },
        { date: "2026-01-01" },
      ],
    }
  );
});

test("renderCalendar gives every cell a role and an aria-label", () => {
  withCalendar(({ calendar, els }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();

    for (const cell of els.calGrid.children) {
      assert.equal(cell.getAttribute("role"), "gridcell");
      assert.equal(
        cell.getAttribute("aria-label"),
        `date:${cell.dataset.date}`
      );
      assert.equal(cell.type, "button");
    }
  });
});

test("renderCalendar describes the entry dot for screen readers", () => {
  withCalendar(
    ({ calendar, els }) => {
      calendar.setCalendarMonth("2026-10-01");
      calendar.renderCalendar();

      const withEntry = els.calGrid.byClass("has-entry");
      assert.equal(withEntry.length, 1);
      assert.equal(
        withEntry[0].getAttribute("aria-description"),
        "editor.calLegend"
      );

      const plain = els.calGrid.children.find(
        (cell) => cell.dataset.date === "2026-10-03"
      );
      assert.equal(plain.getAttribute("aria-description"), null);
    },
    { getEntries: () => [{ date: "2026-10-02" }] }
  );
});

test("renderCalendar shows the day number, not the full date", () => {
  withCalendar(({ calendar, els }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();

    const first = els.calGrid.children.find(
      (cell) => cell.dataset.date === "2026-10-01"
    );
    assert.equal(first.textContent, "1");
  });
});

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

test("openCalendar opens on the month of the selected date", () => {
  withCalendar(
    ({ calendar, els }) => {
      calendar.openCalendar();

      assert.equal(els.calendar.hidden, false);
      assert.equal(els.dateLabel.getAttribute("aria-expanded"), "true");
      assert.equal(calendar.getCalendarMonth(), "2026-03-01");
    },
    { getCurrentDate: () => "2026-03-17" }
  );
});

test("openCalendar falls back to today when no date is selected", () => {
  withCalendar(
    ({ calendar }) => {
      calendar.openCalendar();
      assert.equal(calendar.getCalendarMonth(), "2026-10-01");
    },
    { getCurrentDate: () => "" }
  );
});

test("openCalendar focuses the selected day", () => {
  withCalendar(({ calendar, els }) => {
    calendar.openCalendar();
    assert.equal(document.activeElement.dataset.date, TODAY);
    assert.ok(els.calGrid.children.includes(document.activeElement));
  });
});

test("openCalendar focuses today when nothing is selected", () => {
  withCalendar(
    ({ calendar }) => {
      calendar.openCalendar();
      assert.equal(document.activeElement.dataset.date, TODAY);
    },
    { getCurrentDate: () => "" }
  );
});

test("closeCalendar hides the popup and clears aria-expanded", () => {
  withCalendar(({ calendar, els }) => {
    calendar.openCalendar();
    calendar.closeCalendar();

    assert.equal(els.calendar.hidden, true);
    assert.equal(els.dateLabel.getAttribute("aria-expanded"), "false");
  });
});

test("closeCalendar only restores focus when asked", () => {
  withCalendar(({ calendar, els }) => {
    calendar.openCalendar();

    document.activeElement = null;
    calendar.closeCalendar();
    assert.equal(document.activeElement, null);

    calendar.openCalendar();
    document.activeElement = null;
    calendar.closeCalendar({ restoreFocus: true });
    assert.equal(document.activeElement, els.dateLabel);
  });
});

test("closeCalendar on a closed overlay does nothing", () => {
  withCalendar(({ calendar, els }) => {
    els.calendar.hidden = true;
    els.dateLabel.setAttribute("aria-expanded", "true");

    calendar.closeCalendar({ restoreFocus: true });

    // The stale attribute is left alone: the overlay was already closed.
    assert.equal(els.dateLabel.getAttribute("aria-expanded"), "true");
    assert.equal(document.activeElement, null);
  });
});

// ---------------------------------------------------------------------------
// Background scroll lock
// ---------------------------------------------------------------------------

test("opening the overlay locks background scrolling, closing releases it", () => {
  withCalendar(({ calendar }) => {
    const body = document.body;

    calendar.openCalendar();
    assert.equal(body.classList.contains("calendar-open"), true);

    calendar.closeCalendar();
    assert.equal(body.classList.contains("calendar-open"), false);
  });
});

test("closing an already closed overlay leaves the scroll lock alone", () => {
  withCalendar(({ calendar, els }) => {
    const body = document.body;
    body.classList.add("calendar-open");
    els.calendar.hidden = true;

    calendar.closeCalendar();

    assert.equal(body.classList.contains("calendar-open"), true);
  });
});

test("toggleCalendar opens then closes", () => {
  withCalendar(({ calendar, els }) => {
    calendar.toggleCalendar();
    assert.equal(els.calendar.hidden, false);

    calendar.toggleCalendar();
    assert.equal(els.calendar.hidden, true);
    // Closing via the toggle puts focus back on the date pill.
    assert.equal(document.activeElement, els.dateLabel);
  });
});

test("isCalendarOpen reflects the hidden flag", () => {
  withCalendar(({ calendar, els }) => {
    els.calendar.hidden = true;
    assert.equal(calendar.isCalendarOpen(), false);

    els.calendar.hidden = false;
    assert.equal(calendar.isCalendarOpen(), true);
  });
});

// ---------------------------------------------------------------------------
// Month stepping
// ---------------------------------------------------------------------------

test("stepCalendarMonth moves forward and backward", () => {
  withCalendar(({ calendar }) => {
    calendar.setCalendarMonth("2026-10-01");

    calendar.stepCalendarMonth(1);
    assert.equal(calendar.getCalendarMonth(), "2026-11-01");

    calendar.stepCalendarMonth(-2);
    assert.equal(calendar.getCalendarMonth(), "2026-09-01");
  });
});

test("stepCalendarMonth crosses the year boundary", () => {
  withCalendar(({ calendar }) => {
    calendar.setCalendarMonth("2026-12-01");
    calendar.stepCalendarMonth(1);
    assert.equal(calendar.getCalendarMonth(), "2027-01-01");

    calendar.setCalendarMonth("2026-01-01");
    calendar.stepCalendarMonth(-1);
    assert.equal(calendar.getCalendarMonth(), "2025-12-01");
  });
});

test("stepCalendarMonth re-renders the grid", () => {
  withCalendar(({ calendar, els }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();
    const before = els.calGrid.children[0].dataset.date;

    calendar.stepCalendarMonth(1);
    const after = els.calGrid.children[0].dataset.date;

    assert.notEqual(before, after);
    assert.equal(els.calTitle.textContent, "month:2026-11-01");
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

test("moveCalendarFocus moves one day at a time", () => {
  withCalendar(({ calendar, els }) => {
    calendar.openCalendar();
    const start = document.activeElement;
    const cells = els.calGrid.children;
    const index = cells.indexOf(start);

    calendar.moveCalendarFocus(1);
    assert.equal(document.activeElement, cells[index + 1]);

    calendar.moveCalendarFocus(-1);
    assert.equal(document.activeElement, cells[index]);
  });
});

test("moveCalendarFocus moves a week at a time", () => {
  withCalendar(({ calendar, els }) => {
    calendar.openCalendar();
    const cells = els.calGrid.children;
    const index = cells.indexOf(document.activeElement);

    calendar.moveCalendarFocus(7);
    assert.equal(document.activeElement, cells[index + 7]);
  });
});

test("moveCalendarFocus does nothing when no cell has focus", () => {
  withCalendar(({ calendar, els }) => {
    calendar.openCalendar();
    document.activeElement = els.calTitle;

    calendar.moveCalendarFocus(1);

    assert.equal(document.activeElement, els.calTitle);
  });
});

test("moveCalendarFocus past the last cell flips to the next month", () => {
  withCalendar(({ calendar, els }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();
    const cells = els.calGrid.children;
    cells[cells.length - 1].focus();

    calendar.moveCalendarFocus(1);

    assert.equal(calendar.getCalendarMonth(), "2026-11-01");
    assert.equal(document.activeElement, els.calGrid.children[0]);
  });
});

test("moveCalendarFocus before the first cell flips to the previous month", () => {
  withCalendar(({ calendar, els }) => {
    calendar.setCalendarMonth("2026-10-01");
    calendar.renderCalendar();
    els.calGrid.children[0].focus();

    calendar.moveCalendarFocus(-1);

    assert.equal(calendar.getCalendarMonth(), "2026-09-01");
    const fresh = els.calGrid.children;
    assert.equal(document.activeElement, fresh[fresh.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// Picking a date
// ---------------------------------------------------------------------------

test("pickCalendarDate closes the popup and reports the date", () => {
  withCalendar(({ calendar, els, deps }) => {
    calendar.openCalendar();
    calendar.pickCalendarDate("2026-10-05");

    assert.equal(els.calendar.hidden, true);
    assert.equal(document.activeElement, els.dateLabel);
    assert.deepEqual(deps.selectDate.args(), [["2026-10-05"]]);
  });
});

// ---------------------------------------------------------------------------
// Jumping back to the selected month
// ---------------------------------------------------------------------------

test("jumpToSelectedMonth returns to the month of the selected date", () => {
  withCalendar(
    ({ calendar, els }) => {
      calendar.setCalendarMonth("2026-01-01");
      calendar.renderCalendar();

      calendar.jumpToSelectedMonth();

      assert.equal(calendar.getCalendarMonth(), "2026-03-01");
      assert.equal(els.calTitle.textContent, "month:2026-03-01");
    },
    { getCurrentDate: () => "2026-03-17" }
  );
});

test("jumpToSelectedMonth falls back to today when nothing is selected", () => {
  withCalendar(
    ({ calendar }) => {
      calendar.setCalendarMonth("2026-01-01");
      calendar.jumpToSelectedMonth();
      assert.equal(calendar.getCalendarMonth(), "2026-10-01");
    },
    { getCurrentDate: () => "" }
  );
});

// ---------------------------------------------------------------------------
// Month cursor accessors
// ---------------------------------------------------------------------------

test("getCalendarMonth starts empty and follows setCalendarMonth", () => {
  withCalendar(({ calendar }) => {
    assert.equal(calendar.getCalendarMonth(), "");
    calendar.setCalendarMonth("2026-05-01");
    assert.equal(calendar.getCalendarMonth(), "2026-05-01");
  });
});
