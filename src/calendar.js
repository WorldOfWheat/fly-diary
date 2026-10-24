// ---------------------------------------------------------------------------
// Calendar overlay
// ---------------------------------------------------------------------------
//
// The date pill in the editor header opens a hand-built month grid instead of
// the native `<input type="date">`, because the native picker cannot show which
// days already have an entry and looks different on every platform.
//
// The grid is a full-screen overlay rather than a small popup: at that size a
// whole month is legible at a glance, so the dots marking days that already
// have an entry read as a pattern instead of a detail. Clicking a day jumps
// straight to it.
//
// This module owns the grid, the month cursor and the keyboard navigation. It
// reads the selected date through `getCurrentDate()` and reports a pick through
// `selectDate()`, so it never touches the editor state directly.
//
// `deps` shape:
//
//   els             — the lookup table from `dom.js`
//   getCurrentDate  — () => string        the selected ISO date, or ""
//   selectDate      — (iso: string) => void
//   getEntries      — () => Array<{ date: string }>
//   formatMonth     — (monthStart: string) => string
//   formatDate      — (iso: string) => string
//   weekdayName     — (dayIndex: number) => string
//   t               — (key: string, params?: object) => string
//
// The pure date maths (`toISODate`, `fromISODate`, `monthStartOf`,
// `shiftMonth`, `calendarGrid`) is imported from `lib/dates.js` directly
// rather than injected: it has no state and no I/O, so threading it through
// `deps` only created a second place to forget to wire it up.

import {
  calendarGrid,
  fromISODate,
  monthStartOf,
  shiftMonth,
  toISODate,
} from "./lib/dates.js";

/**
 * Create the calendar controller.
 *
 * Returns the functions `main.js` and `wiring.js` need. The month cursor is
 * private to the closure: nothing outside has to know which month is on screen.
 */
export function createCalendar(deps) {
  const { els } = deps;

  /** First day of the month currently displayed, as `YYYY-MM-01`. */
  let calendarMonth = "";

  /** Dates that already have an entry, for the little dot in the grid. */
  function entryDateSet() {
    return new Set(deps.getEntries().map((entry) => entry.date));
  }

  /**
   * How many days of `monthStart`'s month have an entry.
   *
   * Only days inside the month count: the grid also shows the tail of the
   * previous month and the head of the next one, and those would inflate the
   * number the summary claims for the month on screen.
   */
  function entryCountInMonth(monthStart, withEntries) {
    const prefix = monthStart.slice(0, 7);
    let count = 0;
    for (const iso of withEntries) {
      if (iso.startsWith(prefix)) count += 1;
    }
    return count;
  }

  /** Write the "N days written" line under the month title. */
  function renderSummary(withEntries) {
    if (!els.calSummary) return;
    const month = deps.formatMonth(calendarMonth);
    const count = entryCountInMonth(calendarMonth, withEntries);
    els.calSummary.textContent =
      count === 0
        ? deps.t("editor.calSummaryEmpty", { month })
        : deps.t("editor.calSummary", { month, n: count });
  }

  /** Fill the weekday header row. Monday-first, matching the grid below. */
  function renderWeekdayHeaders() {
    if (!els.calWeekdays) return;
    const frag = document.createDocumentFragment();
    // `getDay()` is Sunday-based; the grid starts on Monday, so walk 1..6 then 0.
    for (let i = 1; i <= 7; i += 1) {
      const span = document.createElement("span");
      span.textContent = deps.weekdayName(i % 7);
      frag.appendChild(span);
    }
    els.calWeekdays.replaceChildren(frag);
  }

  /** Build the 6×7 grid of day buttons for `calendarMonth`. */
  function renderCalendar() {
    const month = Number(calendarMonth.slice(5, 7));
    const monthLabel = deps.formatMonth(calendarMonth);
    els.calTitle.textContent = monthLabel;
    // The month button in the middle of the stepper carries the same label; the
    // heading above it is the dialog title, so it stays generic.
    if (els.calMonth) els.calMonth.textContent = monthLabel;

    const today = toISODate(new Date());
    const currentDate = deps.getCurrentDate();
    const withEntries = entryDateSet();

    renderSummary(withEntries);

    const frag = document.createDocumentFragment();
    for (const iso of calendarGrid(calendarMonth)) {
      const d = fromISODate(iso);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-day";
      btn.dataset.date = iso;
      btn.textContent = String(d.getDate());
      btn.setAttribute("role", "gridcell");
      btn.setAttribute("aria-label", deps.formatDate(iso));

      if (d.getMonth() !== month - 1) btn.classList.add("outside");
      if (iso === today) btn.classList.add("today");
      if (iso === currentDate) {
        btn.classList.add("selected");
        btn.setAttribute("aria-selected", "true");
      }
      if (withEntries.has(iso)) {
        btn.classList.add("has-entry");
        // The dot is decorative, so the fact is repeated for screen readers.
        btn.setAttribute("aria-description", deps.t("editor.calLegend"));
      }

      frag.appendChild(btn);
    }
    els.calGrid.replaceChildren(frag);
  }

  function isCalendarOpen() {
    return !els.calendar.hidden;
  }

  /**
   * Stop the page behind the overlay from scrolling.
   *
   * The overlay is `position: fixed`, so without this a wheel or trackpad
   * gesture over the backdrop would still scroll the editor underneath it.
   */
  function setBackgroundScrollLocked(locked) {
    const body = document.body;
    if (!body) return;
    if (locked) body.classList.add("calendar-open");
    else body.classList.remove("calendar-open");
  }

  function openCalendar() {
    // Always open on the month of the selected date.
    calendarMonth = monthStartOf(
      deps.getCurrentDate() || toISODate(new Date())
    );
    renderCalendar();
    els.calendar.hidden = false;
    els.dateLabel.setAttribute("aria-expanded", "true");
    setBackgroundScrollLocked(true);

    // Focus the selected day so arrow keys work immediately.
    const target =
      els.calGrid.querySelector(".cal-day.selected") ||
      els.calGrid.querySelector(".cal-day.today") ||
      els.calGrid.querySelector(".cal-day");
    if (target) target.focus();
  }

  function closeCalendar({ restoreFocus = false } = {}) {
    if (!isCalendarOpen()) return;
    els.calendar.hidden = true;
    els.dateLabel.setAttribute("aria-expanded", "false");
    setBackgroundScrollLocked(false);
    if (restoreFocus) els.dateLabel.focus();
  }

  function toggleCalendar() {
    if (isCalendarOpen()) closeCalendar({ restoreFocus: true });
    else openCalendar();
  }

  /** Move the calendar view by `months` without changing the selected date. */
  function stepCalendarMonth(months) {
    calendarMonth = shiftMonth(calendarMonth, months);
    renderCalendar();
  }

  /** Move focus to the day `days` away from the currently focused cell. */
  function moveCalendarFocus(days) {
    const cells = [...els.calGrid.querySelectorAll(".cal-day")];
    const index = cells.indexOf(document.activeElement);
    if (index < 0) return;

    const next = cells[index + days];
    if (next) {
      next.focus();
      return;
    }

    // Ran off the grid: flip the month and land on the matching edge.
    stepCalendarMonth(days > 0 ? 1 : -1);
    const fresh = [...els.calGrid.querySelectorAll(".cal-day")];
    const edge = days > 0 ? fresh[0] : fresh[fresh.length - 1];
    if (edge) edge.focus();
  }

  /** Pick a date from the calendar and close it. */
  function pickCalendarDate(iso) {
    closeCalendar({ restoreFocus: true });
    deps.selectDate(iso);
  }

  /** Jump the view back to the month of the selected date. */
  function jumpToSelectedMonth() {
    calendarMonth = monthStartOf(
      deps.getCurrentDate() || toISODate(new Date())
    );
    renderCalendar();
  }

  /** Set the visible month (used by the wiring's month-title handler). */
  function setCalendarMonth(monthStart) {
    calendarMonth = monthStart;
  }

  /** The month currently on screen, as `YYYY-MM-01`. */
  function getCalendarMonth() {
    return calendarMonth;
  }

  return {
    renderWeekdayHeaders,
    renderCalendar,
    isCalendarOpen,
    openCalendar,
    closeCalendar,
    toggleCalendar,
    stepCalendarMonth,
    moveCalendarFocus,
    pickCalendarDate,
    jumpToSelectedMonth,
    setCalendarMonth,
    getCalendarMonth,
  };
}
