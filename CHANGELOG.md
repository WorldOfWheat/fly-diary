# Changelog

本專案遵循 [Semantic Versioning](https://semver.org/)；本文件格式參考
[Keep a Changelog](https://keepachangelog.com/)。

`2.2.0` 是第一個正式版。`0.1.0`–`2.1.0` 是 PoC／pre-release 階段的版本，已被 `2.2.0`
取代；GitHub Releases 會把它們標為 Pre-release。

## [2.2.0] - 2026-11-24

### 新增

- 一天一篇的加密日記，日期為主鍵；同一天再次儲存會覆寫。
- SQLCipher 加密的 SQLite 儲存（page-level AES-256 + HMAC）；DB key 由 diary key 經 HKDF 派生。
- Argon2id 密碼派生與 diary key 包裝；金鑰只存在記憶體，鎖定即清除。
- 可選的 12 字 BIP39 回復短語，可離線重設密碼。
- 加密 `.tar` 備份與匯入／還原（`VACUUM INTO` 快照、金鑰包裝檔、附件）。
- Android 生物辨識解鎖（指紋／臉部），diary key 由 Android Keystore 包裝。
- 全文搜尋（記憶體索引，不落盤）、歷史上的今天、收藏、月曆與日期導覽。
- 圖片相簿：貼上、拖放、排序、lightbox；Rust + libwebp 壓縮並套用 EXIF 方向。
- 多工作區、`.txt` 資料夾匯入、統計、設定頁與唯讀／完整性檢查。
- 繁體中文／英文介面，淺色／深色／跟隨系統主題。
- 手機版兩層式排版（`640px` 以下），桌面可直接預覽。

### 安全性

- SQLCipher 儲存；AAD 綁定 vault、key、日期與格式版本。
- session key 使用 `mlock`／`VirtualLock`，Linux 另排除 dump 與 fork。
- 備份與附件加密；Android 截圖保護（`FLAG_SECURE`）。
- 依賴鎖檔、Action SHA pinning、`cargo audit`／`pnpm audit` 與 release provenance。

### 變更

- 主要儲存改為 SQLCipher；舊 XML 只作為一次性遷移輸入，不再產生
  `YYYY-MM-DD.xml`、`index.xml` 或 `manifest.xml`。
- 附件改為扁平 `attachments/<id>.bin`，以 `attachment_key` 個別加密。
- Linux 只提供 `.deb`／`.rpm`，不提供 AppImage。

### 已知限制

- 尚未完成 200% 文字縮放與螢幕閱讀器實測；WCAG 2.2 AA 是目標，不是已驗證的合規聲明。
- 沒有自動更新；請手動下載新版本。
- macOS／Windows 目前未簽章／未公證；首次開啟可能出現系統警告。
- 完整清單見 [README 的已知限制](README.md#已知限制摘要) 與
  [docs/security.md](docs/security.md#已知限制)。
