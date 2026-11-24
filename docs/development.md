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
  pkg-config \
  perl
```

> SQLCipher 使用 `bundled-sqlcipher-vendored-openssl`，會從原始碼編譯
> SQLite／SQLCipher 與 OpenSSL；需要 C 編譯器、`make` 與 `perl`（上面的
> `build-essential` + `perl` 已包含）。第一次 `cargo build` 會明顯變慢。
>
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

Rust 測試分五層：`src-tauri/src/*.rs` 內的單元測試、`src-tauri/tests/vault_lifecycle.rs`
的日記生命週期整合測試、`src-tauri/tests/sqlcipher_migration.rs` 的 XML→SQLCipher
遷移與快照測試、`src-tauri/tests/attachments_lifecycle.rs` 的附件整合測試
（新增 → 排序 → 上鎖 → 解鎖 → 讀回 → 刪除），以及 `src-tauri/tests/golden_vault.rs`
的 frozen vault 回歸測試。`backup.rs` 另有備份 roundtrip、
路徑穿越拒絕與失敗清理的單元測試。涵蓋加解密 roundtrip、錯誤密碼、密文竄改偵測、
SQLCipher 開啟／完整性、legacy XML 遷移、日期驗證、匯入流程、附件 manifest 重建與孤兒偵測。

`golden_vault.rs` 會複製 `src-tauri/tests/fixtures/golden-vault/` 內由 2.2.0 產生、
已凍結的 `vault.xml`／`recovery.xml`／`diary.db`／附件，用現行 build 解鎖並讀回內容，
同時比對每個檔案的 SHA-256。這是偵測「舊日記是否還能解開」的護欄；測試失敗時請修復
相容性，**不要**重新產生 fixture 讓測試變綠。fixture 的密碼、內容與更新規則見該目錄的
`README.md`。

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

## 發佈

`2.2.0` 是第一個正式版；`0.1.0`–`2.1.0` 在 GitHub Releases 中標為 Pre-release。

### 版號來源

Tauri 以 `src-tauri/tauri.conf.json` 的 `version` 為準；發佈前以下必須一致：

| 位置                        | 用途                          |
| --------------------------- | ----------------------------- |
| `src-tauri/tauri.conf.json` | Tauri 產物與安裝檔版本        |
| `package.json`              | 前端 manifest                 |
| `src-tauri/Cargo.toml`      | Rust crate 版本               |
| `src-tauri/Cargo.lock`      | 執行 `cargo check` 後自動更新 |
| `README.md`                 | 對外顯示的目前版本            |
| `CHANGELOG.md`              | 版本變更紀錄                  |

Tag 必須是 `v` + 版本號（例如 `v2.2.0`）。`release.yml` 會在建置前檢查 tag 與
`tauri.conf.json` 是否一致。

### 流程

1. 更新上表版本與 `CHANGELOG.md`。
2. 跑 `./test.sh`（或至少 `./test.sh --no-cov`）。
3. commit 後建立 annotated tag：`git tag -a v2.2.0 -m "Fly Diary 2.2.0"`。
4. push tag：`git push origin v2.2.0`。
5. `release.yml` 先跑測試與 `security.yml` 審計，再在 Linux／macOS／Windows 建置並建立
   GitHub Release。
6. 檢查 Release 是否有 `.deb`／`.rpm`／`.dmg`／`.msi`／`.exe` 與 provenance；必要時重新執行
   workflow。

`releaseDraft` 目前設為 `false`，tag 通過測試與審計後會直接公開。若要先人工檢查，可暫時改回
`true`，檢查完再 publish。

### 產物與簽章

- Linux：`.deb`、`.rpm`（不產出 AppImage）。
- macOS：`.dmg`（目前 runner 為 Apple Silicon）。
- Windows：`.msi`、`x64-setup.exe`。
- 目前 workflow 只使用 `GITHUB_TOKEN`，沒有 Apple notarization 或 Windows code-signing
  secrets，因此產物未簽章。若要簽章，把憑證放在 `release` environment 的 secrets，並在
  `tauri-action` 前設定對應環境變數。
- Android 由 `.github/workflows/android.yml` 在 `v*` tag 另外建置，APK／AAB 上傳到該次
  Actions run 的 artifacts（保留 30 天），**不會自動附加到 GitHub Release**。若要長期提供
  下載，需手動上傳或調整 workflow。

### 版號政策

- 正式版從 `2.2.0` 開始；舊的 `0.1.0`–`2.1.0` 是 PoC／pre-release。
- 之後遵循 SemVer：向後相容的功能用 MINOR，修正用 PATCH，不相容的變更用 MAJOR。
- 不要重用或移動已發佈的 tag。

## 行動版（Android）

手機版沿用同一份前端，靠 `640px` 斷點切換成兩層式排版。Tauri 產生的 Android 專案位於
`src-tauri/gen/android`，已列在 `.gitignore`；需要 Android SDK／NDK 與對應的
Rust target，之後可用 `pnpm tauri android dev` / `pnpm tauri android build` 建置。

Android 的備份與截圖保護由 `scripts/harden-android.mjs` 套用（`AndroidManifest.xml` 的
`allowBackup`／backup rules、`MainActivity` 的 `FLAG_SECURE`）。`src-tauri/gen/android` 是
generated 專案，仍保持 gitignored；重新產生後請用 `pnpm android:init`、`pnpm android:dev` 或
`pnpm android:build`，這些指令會先跑 patch script。備份保持開啟，讓 `vault.xml`、`recovery.xml`
與日記可以在換手機後還原；Android 12+ 的雲端備份會加上
`disableIfNoEncryptionCapabilities="true"`，沒有備份加密能力時不上傳。

行動版有三個刻意不同的行為：

- **沒有日記資料夾選擇器**：`pick_diary_dir` 在 `#[cfg(mobile)]` 下直接回傳 App 私有資料夾，不開原生對話框；日記因此固定放在 App 的資料目錄。備份檔則透過系統檔案選擇器存到 SAF 可寫入的位置。
- **不支援 `.txt` 資料夾匯入**：`pick_import_dir` 在行動版直接回報錯誤，而不是回傳 `None` 讓使用者以為自己取消。
- 選單列只在桌面建置（`build_menu` 包在 `#[cfg(desktop)]`），行動版沒有 `Edit` 選單可掛。

其餘加密、SQLCipher 儲存與備份流程在桌面與行動版完全相同。Android 交叉編譯
`bundled-sqlcipher-vendored-openssl` 需要 NDK 的 `CC_*`／`AR_*`／`RANLIB_*` 與
`perl`；若 `pnpm android:dev` 在建置 OpenSSL 時失敗，先確認這些工具在 PATH 中。

### Android 備份匯出

手機版的備份使用 `tauri-plugin-dialog` 的系統檔案選擇器與 `tauri-plugin-fs` 開啟
`content://` 檔案，不需要自訂 SAF 外掛。備份是單一 `.tar`，寫入位置由使用者選擇；
`diary.db` 仍留在 App 私有資料夾。還原時會先解到 App cache，驗證後才替換 DB 與附件，
舊資料留在私有資料夾旁的 `*.local-backup-*`。第一次啟動的解鎖畫面與設定 → 資料移轉
都提供 `.tar` 匯入；匯入會採用備份的 `vault.xml`／`recovery.xml`，適合換手機或在
App 資料被清除後重建。

### Android 生物辨識 plugin

`src-tauri/plugins/biometric` 是一個 app-local Tauri Android plugin：

- Rust 端 `fly_diary_biometric::init()` 在 Android 註冊 `com.flydiary.biometric.BiometricPlugin`，
  並把可 clone 的 `PluginHandle` 放進 Tauri state；桌面版是 no-op。
- Kotlin 端使用 `androidx.biometric:biometric:1.1.0` 與 Android Keystore，
  建立 per-use、`BIOMETRIC_STRONG`、`setInvalidatedByBiometricEnrollment(true)` 的 AES-GCM key。
- `plugins/biometric/build.rs` 透過 `tauri_plugin::Builder::android_path("android")` 把 Kotlin
  專案接進 Tauri 的 Android build；`android/.tauri` 由 build script 產生，已 gitignore。
- 初次建置需要 Gradle 下載 AndroidX Biometric；不需要額外的系統權限，manifest 會 merge
  `USE_BIOMETRIC`／`USE_FINGERPRINT`。
- 包裝檔 `biometric.json` 是裝置綁定的，不進 `.tar`；測試 Rust 端可用單元測試，原生
  BiometricPrompt 需在 emulator（`adb -e emu finger touch 1`）或實機驗證。
