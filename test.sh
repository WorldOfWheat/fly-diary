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
if [[ $COVERAGE -eq 1 ]]; then
  node --test --experimental-test-coverage "tests/*.test.js"
else
  node --test "tests/*.test.js"
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
