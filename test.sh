#!/usr/bin/env bash
#
# Run every test suite, then print coverage for both halves of the app.
#
#   ./test.sh              tests + coverage
#   ./test.sh --no-cov     tests only (faster)
#
# The frontend is plain ES modules with no bundler, so its tests run on Node's
# built-in runner. The Rust side uses cargo; coverage needs `cargo-llvm-cov`
# (`cargo install cargo-llvm-cov --locked` plus `rustup component add
# llvm-tools-preview`).

set -euo pipefail

cd "$(dirname "$0")"

COVERAGE=1
if [[ "${1:-}" == "--no-cov" ]]; then
  COVERAGE=0
fi

echo "==> Frontend tests"
# Node's test runner treats an unmatched glob as a hard error, which turns a
# wrong checkout (e.g. a branch without tests/) into a confusing "Could not
# find ..." failure. Fail with a message that says what is actually wrong.
if ! compgen -G "tests/*.test.js" >/dev/null; then
  echo "error: no tests/*.test.js found in $(pwd)" >&2
  echo "       (is this the right branch? tests/ lives on develope)" >&2
  exit 1
fi
# Leave the glob unquoted so the shell expands it into a file list. Node's
# `--test` only understands glob patterns from v21 onwards, so quoting it
# breaks on Node 20 runners with "Could not find '.../tests/*.test.js'".
if [[ $COVERAGE -eq 1 ]]; then
  node --test --experimental-test-coverage tests/*.test.js
else
  node --test tests/*.test.js
fi

echo
echo "==> Rust tests"
if [[ $COVERAGE -eq 1 ]]; then
  if cargo llvm-cov --version >/dev/null 2>&1; then
    cargo llvm-cov --manifest-path src-tauri/Cargo.toml --summary-only
  else
    echo "cargo-llvm-cov is not installed; running tests without coverage."
    echo "Install it with: cargo install cargo-llvm-cov --locked"
    cargo test --manifest-path src-tauri/Cargo.toml
  fi
else
  cargo test --manifest-path src-tauri/Cargo.toml
fi
