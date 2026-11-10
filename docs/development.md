# 開發

[← 回到 README](../README.md) · [文件索引](README.md)

這一頁說明建置環境、測試與打包。供應鏈防護與 CI 的設計請見 [security.md](security.md#供應鏈安全)。

## 安裝系統依賴（Linux）

Tauri 在 Linux 需要 WebKitGTK 等系統函式庫。以 Debian/Ubuntu/Linux Mint 為例：

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libdbus-1-dev \
  pkg-config
```

> 其他發行版請參考 [Tauri 官方 Prerequisites](https://tauri.app/start/prerequisites/)。

## 安裝前端依賴

專案使用 **pnpm**（版本由 `package.json` 的 `packageManager` 欄位鎖定為 `9.15.4`）：

```bash
pnpm install --frozen-lockfile
```

專案根目錄的 `.npmrc` 設定了 `ignore-scripts=true`，因此安裝依賴時不會執行任何
lifecycle script。目前兩個 Tauri 套件都不需要 install script；若未來新增的套件真的
需要，必須在 `.npmrc` 明確放行並在 PR 中說明。

## 啟動開發模式

```bash
pnpm dev
```

## 執行測試

```bash
./test.sh              # 前端 + Rust 測試，並印出兩邊的 coverage
./test.sh --no-cov     # 只跑測試，不量測覆蓋率
```

也可以分開執行：

```bash
pnpm test                # 前端（node --test）
pnpm run test:rust       # Rust（cargo test --locked）
pnpm run coverage        # 前端 + Rust coverage
pnpm run audit:npm       # pnpm audit（需要網路）
pnpm run audit:rust      # cargo audit（需先安裝 cargo-audit）
```

前端測試放在 `tests/`，用 Node 內建的 test runner（Node 20 以上；CI 用 Node 24），不需要額外安裝套件；受測的純函式在
`src/lib/dates.js` 與 `src/lib/stats.js`，`src/i18n.js` 另有字典完整性檢查（兩份字典的
key 必須一致、`index.html`、`main.js` 與 `attachments.js` 用到的 key 必須存在）。

各對話框與相簿模組（`calendar.js`、`import-dialog.js`、`stats-dialog.js`、`settings-dialog.js`、
`lock-screen.js`、`attachments.js`）都以 `createXxx(deps)` 工廠形式匯出，依賴全部由參數注入，
因此可以在 Node 裡直接測試。`tests/helpers/dom.js` 提供一個約 300 行的極簡 DOM stub（`fakeElement`、
`installDom`、`fakeEls`、`fakeT`、`spy`、`fakeInvoke`），不需要 jsdom 之類的額外套件；
遇到 stub 不支援的 selector 會直接丟錯，避免測試默默通過。

`tests/styles.test.js` 補上 DOM stub 看不到的一層：它讀入口 `styles.css` 及其 `@import` 的
`styles/*.css`，驗證
`[hidden]` 疊層不會被 `display` 蓋掉、月曆與 lightbox 的 `z-index` 順序，以及手機版的
`.app[data-layer]` 顯隱規則與返回鈕的顯示條件。這類規則若寫錯，其他測試不會失敗，但使用者會看到
一個透明卻吃掉所有點擊的浮層（或永遠離不開編輯器）。

`tests/docs-links.test.js` 檢查 README 與 `docs/*.md` 的相對連結都指向存在的檔案，
並確認每份文件都有被索引連到，避免拆檔後出現連不到的孤島。

`tests/a11y.test.js` 與 `tests/focus-trap.test.js` 是無障礙回歸護欄：表單標籤、live region、
`aria-pressed`、muted／border 對比、placeholder、24px target size，以及 modal 的 Tab 循環與
焦點還原。它們不能取代螢幕閱讀器實測，完整清單見 [accessibility.md](accessibility.md)。

Rust 測試分三層：`src-tauri/src/*.rs` 內的單元測試、`src-tauri/tests/vault_lifecycle.rs`
的日記生命週期整合測試，以及 `src-tauri/tests/attachments_lifecycle.rs` 的附件整合測試
（新增 → 排序 → 上鎖 → 解鎖 → 讀回 → 刪除）。涵蓋加解密 roundtrip、錯誤密碼、密文竄改偵測、
XML 序列化、日期驗證、索引重建、匯入流程、manifest 重建與孤兒偵測。

Rust coverage 需要 `cargo-llvm-cov`：

```bash
rustup component add llvm-tools-preview
cargo install cargo-llvm-cov --locked
```

## 打包

```bash
pnpm build
```

Linux 只產出 `.deb` 與 `.rpm`，**不產出 AppImage**。AppImage 會把 GTK 一起打包，並在 `AppRun` 裡把 `GTK_IM_MODULE_FILE` 指向打包內的 `immodules.cache`；該 cache 不含 `im-ibus.so` / `im-fcitx.so`，導致輸入法在 AppImage 內完全無法切換。`.deb` / `.rpm` 直接使用系統的 GTK 與系統的輸入法模組，沒有這個問題。

## 行動版（Android）

手機版沿用同一份前端，靠 `640px` 斷點切換成兩層式排版。Tauri 產生的 Android 專案位於
`src-tauri/gen/android`，已列在 `.gitignore`，不隨 repo 提交；需要 Android SDK／NDK 與對應的
Rust target，之後可用 `pnpm tauri android dev` / `pnpm tauri android build` 建置。

行動版有三個刻意不同的行為：

- **沒有資料夾選擇器**：`pick_diary_dir` 在 `#[cfg(mobile)]` 下直接回傳 App 私有資料夾，不開原生對話框；日記因此固定放在 App 的資料目錄。
- **不支援資料夾匯入**：`pick_import_dir` 在行動版直接回報錯誤，而不是回傳 `None` 讓使用者以為自己取消。
- 選單列只在桌面建置（`build_menu` 包在 `#[cfg(desktop)]`），行動版沒有 `Edit` 選單可掛。

其餘加密、儲存、索引與背景升級流程在桌面與行動版完全相同。
