// ---------------------------------------------------------------------------
// Search-result highlighting
// ---------------------------------------------------------------------------
//
// The backend returns UTF-16 ranges relative to the snippet it also returns.
// Splitting is kept pure so it can be tested without a DOM: `main.js` turns the
// segments into text nodes and `<mark>` elements, never `innerHTML`.

/**
 * Split `text` into plain and marked segments.
 *
 * @param {string} text
 * @param {Array<[number, number]>} ranges UTF-16 offsets, usually sorted.
 * @returns {Array<{ text: string, marked: boolean }>}
 */
export function highlightedSegments(text, ranges) {
  const source = typeof text === "string" ? text : "";
  const safeRanges = Array.isArray(ranges) ? ranges : [];
  const segments = [];
  let cursor = 0;

  const push = (text, marked) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.marked === marked) {
      last.text += text;
    } else {
      segments.push({ text, marked });
    }
  };

  for (const [rawStart, rawEnd] of safeRanges) {
    const start = Math.max(cursor, Number(rawStart) || 0);
    const end = Math.min(source.length, Number(rawEnd) || 0);
    if (end <= start) continue;

    push(source.slice(cursor, start), false);
    push(source.slice(start, end), true);
    cursor = end;
  }

  push(source.slice(cursor), false);
  return segments;
}
