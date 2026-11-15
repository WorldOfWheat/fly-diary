import test from "node:test";
import assert from "node:assert/strict";

import { highlightedSegments } from "../src/lib/highlight.js";

test("a range in the middle splits the text into three segments", () => {
  assert.deepEqual(highlightedSegments("hello world", [[6, 11]]), [
    { text: "hello ", marked: false },
    { text: "world", marked: true },
  ]);
});

test("multiple ranges keep their order and the gaps between them", () => {
  assert.deepEqual(highlightedSegments("abcdef", [[1, 2], [4, 5]]), [
    { text: "a", marked: false },
    { text: "b", marked: true },
    { text: "cd", marked: false },
    { text: "e", marked: true },
    { text: "f", marked: false },
  ]);
});

test("overlapping ranges do not duplicate text", () => {
  assert.deepEqual(highlightedSegments("abcdef", [[1, 4], [3, 6]]), [
    { text: "a", marked: false },
    { text: "bcdef", marked: true },
  ]);
});

test("out-of-range ranges are clamped to the string", () => {
  assert.deepEqual(highlightedSegments("abc", [[-2, 99]]), [
    { text: "abc", marked: true },
  ]);
  assert.deepEqual(highlightedSegments("abc", [[3, 5]]), [
    { text: "abc", marked: false },
  ]);
});

test("empty or reversed ranges are ignored", () => {
  assert.deepEqual(highlightedSegments("abc", [[1, 1], [2, 1]]), [
    { text: "abc", marked: false },
  ]);
});

test("no ranges leaves the whole string plain", () => {
  assert.deepEqual(highlightedSegments("abc", []), [
    { text: "abc", marked: false },
  ]);
  assert.deepEqual(highlightedSegments("", []), []);
});

test("ranges are UTF-16 offsets, so emoji stay intact", () => {
  const text = "a😀b";
  assert.deepEqual(highlightedSegments(text, [[1, 3]]), [
    { text: "a", marked: false },
    { text: "😀", marked: true },
    { text: "b", marked: false },
  ]);
});

test("a non-string input becomes an empty result", () => {
  assert.deepEqual(highlightedSegments(null, [[0, 1]]), []);
  assert.deepEqual(highlightedSegments("abc", null), [
    { text: "abc", marked: false },
  ]);
});
