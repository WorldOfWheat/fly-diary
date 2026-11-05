# Fly Diary

一個用 Tauri 2 寫的極簡加密日記 App：**一天只會有一篇**，以 **AES-256-GCM 加密的 XML** 檔案儲存。
目前版本 `0.1.6`。桌面版之外，原始碼也包含 Android 所需的手機版排版與 `cfg(mobile)` 分支；
把視窗縮到 `640px` 以下即可在桌面上預覽手機版介面。

## 功能亮點

- 一天一篇：檔名即日期（`YYYY-MM-DD.xml`），同一天再存只會覆寫，不會產生重複
- **AES-256-GCM 加密**：內容以 RustCrypto 的 `aes-gcm` 加密，每次寫入使用新的隨機 IV
- **密碼保護**：Argon2id 派生 master key，再包裝一把隨機 diary key；金鑰只存在記憶體，鎖定即清除
- **標題也加密**：標題、內容與收藏旗標全在密文裡；側邊欄標題來自解密後的 `index.xml` 快取
- **多工作區**：解鎖畫面可直接切換日記資料夾；已有 vault 的資料夾會直接進入解鎖
- 純 HTML/JS 前端，無框架、無打包步驟
- 自動儲存、側邊欄搜尋、收藏、日期前後切換與**全螢幕月曆**
- **從資料夾匯入** `YYYY-MM-DD.txt`：先掃描預覽再確認，並列出失敗檔案
- **圖片相簿**：檔案選擇、**貼上**、**拖放**、刪除、拖曳／箭頭排序與點擊放大；圖片個別加密，
  上傳前自動縮到長邊 1000px 並移除 EXIF
- **唯讀開啟與損壞檔保護**：已寫過的日記先唯讀；壞檔不會拖垮清單，可匯出原始檔或確認後刪除
- **設定頁**：儲存位置、匯入、統計、閒置自動鎖定、自動儲存延遲、變更密碼與 Argon2id 參數
- **繁體中文／英文**、淺色／深色／跟隨系統主題
- **手機版兩層式排版**：`640px` 以下把列表與編輯器拆成兩層，支援觸控與安全區
- 刪除單日記（有確認提示）
- 使用**本地時區**判定「今天」，不會因 UTC 造成跨日錯亂

更完整的功能行為與實作細節請見 [文件索引](docs/README.md)。

## 快速開始

需求：Node 20 以上、pnpm `9.15.4`、Rust（CI 固定 `1.98.1`）。
Linux 另需 WebKitGTK 等系統函式庫，完整清單見 [docs/development.md](docs/development.md#安裝系統依賴linux)。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

執行測試與打包：

```bash
./test.sh --no-cov     # 前端 + Rust 測試
pnpm build             # 打包（Linux 產出 .deb / .rpm）
```

## 文件

| 文件 | 內容 |
| --- | --- |
| [security.md](docs/security.md) | 金鑰階層、KDF、AAD 與版本、記憶體保護、供應鏈安全、已知限制 |
| [file-format.md](docs/file-format.md) | 日記／vault／索引／附件的檔案格式、設定檔與儲存位置 |
| [ui.md](docs/ui.md) | 唯讀、月曆、縮放、手機版、多語系、設定頁、主題 |
| [architecture.md](docs/architecture.md) | 專案結構與設計取捨 |
| [development.md](docs/development.md) | 系統依賴、開發指令、測試、打包、Android |
| [reference.md](docs/reference.md) | 鍵盤快速鍵與 Tauri Commands |

## 安全摘要

- 日記以 AES-256-GCM 加密；AAD 綁定日期與版本，搬檔或降級改寫都會解密失敗。
- master key 由密碼經 Argon2id 派生，只用來包裝 diary key；改密碼只重包裝 32 bytes。
- session key 放在專用鎖定頁（`mlock` / `VirtualLock`），Linux 另排除 dump 與 fork。
- ⚠️ **忘記密碼無法救回**：沒有後門或回復機制。

完整的金鑰階層、KDF 校準、記憶體保護與供應鏈防護請見 [docs/security.md](docs/security.md)。

## 已知限制（摘要）

- 日期（檔名與 `<date>`）是明文；標題與內容才是密文。
- webview 內的明文與 `session_key()` 的暫時副本不在鎖定頁內；`mlock` 也不阻止休眠。
- 跨檔案沒有交易，靠寫入順序讓中斷只留下可自癒的索引落後狀態。
- 圖片是相簿，不是圖文混排；1000px 在 2x 螢幕全螢幕檢視時可能偏軟。

完整列表請見 [docs/security.md#已知限制](docs/security.md#已知限制)。
