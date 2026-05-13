// Shared slug-parity fixture. Imported by upload.test.js (worker
// validation) and read.test.js (route matching). The CLI test file
// (cli/test/wwwshare.test.mjs) keeps its own copy because it lives in a
// separate workspace — drift would surface in either test suite.
//
// This file MUST NOT register any tests (no top-level describe/it). If
// you add anything that imports vitest, split it again.
export const VALID_SLUGS = [
  "a",
  "ab",
  "a-b",
  "abc-123",
  "12345",
  "a".repeat(64),
  "a-b-c-d",
];
export const INVALID_SLUGS = [
  ["", "empty"],
  ["A", "uppercase"],
  ["-abc", "leading dash"],
  ["abc-", "trailing dash"],
  ["a_b", "underscore"],
  ["a.b", "dot"],
  ["a!b", "bang"],
  ["a".repeat(65), "65 chars"],
  ["abc def", "space"],
  ["abc/def", "slash"],
];
