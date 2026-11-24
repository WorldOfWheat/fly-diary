# 貢獻指南

## 開發環境

需求：Node 20 以上、pnpm `9.15.4`、Rust（CI 固定 `1.98.1`；`Cargo.toml` 最低 `1.90.0`）。
Linux 另需 WebKitGTK 等系統依賴，完整清單見
[docs/development.md](docs/development.md#安裝系統依賴linux)。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

## 測試

```bash
./test.sh --no-cov   # 前端 + Rust
pnpm test            # 只跑前端
pnpm run test:rust   # 只跑 Rust
./test.sh            # 測試 + coverage（需要 cargo-llvm-cov）
```

送 PR 前至少跑 `./test.sh --no-cov`。文件改動也要跑 `pnpm test`：
`tests/docs-links.test.js` 會檢查相對連結是否存在，以及每份 `docs/*.md` 是否都有被索引連到。

## 程式風格

- 前端是無框架的 HTML/CSS/JS；沿用現有的 `createXxx(deps)` 工廠與相依注入，讓模組可在 Node 測試。
- 不要新增 bundler 或前端框架，除非先討論。
- UI 字串要同時更新 `src/i18n.js` 的中英文字典；`tests/i18n.test.js` 會檢查 key 一致。
- 新增互動元素時補上 `data-testid` 與無障礙語意；相關測試見 `tests/a11y.test.js`、`tests/focus-trap.test.js`。
- Rust 端維持 `--locked` 可建置；新增依賴請說明理由並確認 `cargo audit`。
- 文件以繁體中文為主；新增檔案要更新 [docs/README.md](docs/README.md) 與 README 的索引。

## Commit 與 PR

- 使用 Conventional Commits，例如 `feat(ui): ...`、`fix(backup): ...`、`docs: ...`。
- PR 以 `master` 為目標；CI 與 security workflow 會在 PR 到 `master` 時執行。日常整合分支是
  `develope`，由維護者合併後發佈。
- 請勿提交日記資料、備份檔、金鑰、密碼或任何個人資料。
- 一個 PR 盡量只做一件事；行為變更請附測試。

## 安全性

請不要用公開 issue 回報漏洞；流程見 [SECURITY.md](SECURITY.md)。

## 授權

送出貢獻即表示你同意以本專案的 [MIT License](LICENSE) 授權你的貢獻。
