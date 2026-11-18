# Fly Diary

一個用 Tauri 2 寫的極簡加密日記 App：**一天只會有一篇**，以 **SQLCipher 加密的 SQLite** 儲存，
並可匯出單一加密備份檔（資料庫快照 + 金鑰包裝檔 + 附件）。
目前版本 `2.0.1`。桌面版之外，原始碼也包含 Android 所需的手機版排版與 `cfg(mobile)` 分支；
把視窗縮到 `640px` 以下即可在桌面上預覽手機版介面。

## 功能亮點

- 一天一篇：SQLite 以 `entries.date` 為主鍵，同一天再存只會覆寫
- **SQLCipher 加密**：資料庫以 page-level AES-256 + HMAC 加密，DB key 由 diary key 經 HKDF 派生
- **加密備份**：一鍵匯出加密 `.tar`，內含 `VACUUM INTO` 的資料庫快照、`vault.xml`／`recovery.xml` 與所有附件；
  還原時先驗證備份屬於同一個 vault，再把目前資料庫與附件保留到 `*.local-backup-*`
- **密碼保護**：Argon2id 派生 master key，再包裝一把隨機 diary key；金鑰只存在記憶體，鎖定即清除
- **可選的回復短語**：12 個 BIP39 英文單字，可離線重設密碼；只顯示一次、不可選取或複製，確認時在獨立視窗輸入指定單字（附前綴建議）
- **標題也加密**：SQLCipher 加密整個資料庫，標題、內容與收藏旗標都在加密頁面內；側邊欄直接查詢 DB
- **多工作區**：解鎖畫面可直接切換日記資料夾；已有 vault 的資料夾會直接進入解鎖
- 純 HTML/JS 前端，無框架、無打包步驟
- 自動儲存、收藏、日期前後切換與**全螢幕月曆**
- **全文搜尋**：解鎖後從 SQLCipher 讀入 Rust 記憶體建立索引，可搜尋標題與內容；支援多關鍵字 AND、
  引號片語、日期與收藏頁內搜尋，結果附命中摘要。索引不落盤，鎖定時清除
- **歷史上的今天**：在編輯器上方快速回顧 1 個月前、6 個月前、1 年前、3 年前與 5 年前的日記；
  可摺疊並記住展開狀態，只使用側邊欄已載入的日期與標題，不新增解密或落盤
- **清單導覽**：側邊欄依月份分組，月與月之間以標線和月份標籤分隔；頂端固定年份選單可直接跳到該年第一篇；桌面版可收合側邊欄並記住狀態
- **解鎖轉場**：按下解鎖立即顯示「解鎖中…」與旋轉指示，成功後鎖定畫面淡出、日記介面淡入；首次掃描同時進行，並尊重系統的減少動態偏好
- **介面動態**：overlay 關閉淡出、手機列表／編輯器滑動、收藏星號彈跳、清單篩選過場、附件進場與排序、主題過場與儲存提示；全部尊重 `prefers-reduced-motion`
- **從資料夾匯入** `YYYY-MM-DD.txt`：先掃描預覽再確認，並列出失敗檔案
- **圖片相簿**：檔案選擇、**貼上**、**拖放**、刪除、拖曳／箭頭排序與點擊放大；manifest 在 DB，圖片以 HKDF 派生的 `attachment_key` 個別加密，
  上傳前自動縮到長邊 1000px 並移除 EXIF
- **唯讀開啟與完整性檢查**：已寫過的日記先唯讀；SQLCipher 以 `cipher_integrity_check` 驗證，舊格式壞檔在遷移報告中列出
- **設定頁**：儲存位置、匯入、統計、備份提示、閒置自動鎖定、自動儲存延遲、變更密碼、Argon2id 參數、回復短語，以及版本／commit／作者資訊
- **繁體中文／英文**、淺色／深色／跟隨系統主題
- **手機版兩層式排版**：`640px` 以下把列表與編輯器拆成兩層，支援觸控與安全區
- **無障礙基礎**：列表可用鍵盤操作、表單有標籤、modal 有焦點圈禁，主要文字與控制項對比符合 WCAG 2.2 AA 目標
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

| 文件                                      | 內容                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ |
| [security.md](docs/security.md)           | 金鑰階層、KDF、AAD 與版本、記憶體保護、供應鏈安全、已知限制        |
| [sqlcipher.md](docs/sqlcipher.md)         | SQLCipher 儲存層、HKDF 子金鑰、加密備份與舊格式遷移                |
| [file-format.md](docs/file-format.md)     | `vault.xml`／`recovery.xml`／備份 `.tar`／附件的檔案格式與儲存位置 |
| [ui.md](docs/ui.md)                       | 唯讀、月曆、縮放、手機版、多語系、設定頁、主題                     |
| [css-reset.md](docs/css-reset.md)         | 瀏覽器 reset 的規則目的、載入順序與覆寫方式                        |
| [accessibility.md](docs/accessibility.md) | WCAG 2.2 AA 目標、已完成項目、手動驗證與剩餘缺口                   |
| [architecture.md](docs/architecture.md)   | 專案結構與設計取捨                                                 |
| [development.md](docs/development.md)     | 系統依賴、開發指令、測試、打包、Android                            |
| [reference.md](docs/reference.md)         | 鍵盤快速鍵與 Tauri Commands                                        |

## 安全摘要

- 日記以 SQLCipher 加密（DB key 由 diary key 經 HKDF 派生）。備份檔是 `VACUUM INTO` 的加密資料庫快照加上金鑰包裝檔與附件密文，**不包含新的明文**；備份檔本身沒有額外密碼，安全邊界仍是密碼／回復短語。
- master key 由密碼經 Argon2id 派生（新 vault 預設 64 MiB／3 iterations、密碼至少 12 字元），只用來包裝 diary key；改密碼只重包裝 32 bytes。
- 回復短語是**另一把獨立金鑰**，包裝同一把 diary key；它存在 `recovery.xml`，不在 `vault.xml` 裡。
- session key 放在專用鎖定頁（`mlock` / `VirtualLock`），Linux 另排除 dump 與 fork。
- ⚠️ **沒有密碼或回復短語就無法救回**：沒有後門。短語只顯示一次，遺失即失效；取得短語與日記檔的人可直接讀取全部內容。

完整的金鑰階層、KDF 校準、記憶體保護與供應鏈防護請見 [docs/security.md](docs/security.md)。

## 已知限制（摘要）

- 日期不是獨立的明文檔名；只有附件資料夾仍以 `YYYY-MM-DD` 命名。標題與內容都在加密頁面內。
- webview 內的明文與 `session_key()` 的暫時副本不在鎖定頁內；`mlock` 也不阻止休眠，App 會在 suspend／背景化時盡量先鎖定。
- 手動複製整個資料夾前請先鎖定日記，確保資料庫已 checkpoint；直接複製執行中的資料庫不是一致快照。
- 圖片是相簿，不是圖文混排；1000px 在 2x 螢幕全螢幕檢視時可能偏軟。
- 全文搜尋索引只存在解鎖期間的 Rust 記憶體；解鎖後第一次載入需要解密全部日記，日記量大或放在網路磁碟時會較慢。掃描、匯入、升級與搜尋會使用最多 4 條背景執行緒，SSD 上較有感。索引不進 `mlock`，鎖定時清除。
- **備份不是同步服務**：備份複本不會自動上傳，也不會在兩台裝置間合併變更；使用者要自行把整個日記資料夾複製到其他位置。還原 `.tar` 會回到備份當時的資料庫與附件，備份之後的變更不會保留（目前資料會留在 `*.local-backup-*`）。
- 若 `diary.db` 損壞，解鎖畫面在密碼驗證成功後會提供「還原加密備份」；App 不會自動建立空資料庫。
- 備份檔含 `vault.xml` 與 `recovery.xml`，方便在 App 無法解鎖時手動救援；但用 App 內還原時不會覆寫目前的金鑰包裝檔，避免把密碼或回復短語回滾到舊狀態。
- 回復短語是明文可讀的第二把鑰匙，必須與日記分開保存；它不會自動備份，也不會顯示第二次。備份檔已包含 `recovery.xml`，但仍建議與日記分開保存。

完整列表請見 [docs/security.md#已知限制](docs/security.md#已知限制)。
