# Fly Diary

一個用 Tauri 2 寫的極簡加密日記 App：**一天只會有一篇**，以 **AES-256-GCM 加密的 XML** 檔案儲存。

## 功能

- 一天一篇：檔名即日期（`YYYY-MM-DD.xml`），同一天再存只會覆寫，不會產生重複
- **AES-256-GCM 加密**：日記內容以 RustCrypto 的 `aes-gcm` 加密，每次寫入使用新的隨機 IV
- **首次啟動設定儲存路徑**：可自訂日記資料夾（含原生資料夾選擇器），路徑寫入設定檔
- **密碼保護**：首次啟動設定密碼，之後每次開啟需解鎖；金鑰只存在記憶體，鎖定即清除
- 每篇日記有 **標題（title）** 與內容，標題以明文儲存以便側邊欄顯示
- 純 HTML/JS 前端，無框架、無打包步驟
- 自動儲存（停止輸入 0.8 秒後），切換日期前也會先存檔
- 側邊欄列出所有日記，可依日期或標題搜尋
- 日期前後切換、自訂月曆選擇器、「今天」快速鍵
- **從資料夾匯入**：讀取 `YYYY-MM-DD.txt`，先掃描預覽再確認，並列出失敗的檔案
- **繁體中文／英文介面**：右上角一鍵切換，日期格式也跟著語言改變
- 刪除單日記（有確認提示）
- 使用**本地時區**判定「今天」，不會因 UTC 造成跨日錯亂

## 鍵盤快速鍵

| 快速鍵                | 功能            |
| --------------------- | --------------- |
| `Ctrl/Cmd + S`        | 立即儲存        |
| `Ctrl/Cmd + T`        | 跳到今天        |
| `Ctrl/Cmd + L`        | 鎖定日記        |
| `Ctrl/Cmd + +`        | 放大字體        |
| `Ctrl/Cmd + -`        | 縮小字體        |
| `Ctrl/Cmd + 0`        | 重設字體大小    |
| `Alt + ←` / `Alt + →` | 前一天 / 後一天 |

## 介面縮放

整個介面以 `rem` 排版，根字級由兩層組成：

1. **隨視窗流動**：`clamp(0.875rem, 0.78rem + 0.28vw, 1.125rem)`，視窗越寬字越大，但限制在 14–18px，避免小視窗擠爆、大螢幕字過大。
2. **使用者倍率**：`--font-scale`（0.8–1.6），由編輯區底部的 `A− / 100% / A+` 控制，或 `Ctrl/Cmd + +` / `-` / `0`。設定存在 `localStorage`，下次啟動自動還原。

因為所有尺寸（內距、圖示、日曆、對話框）都是 `rem`，調整根字級會一次縮放整個介面，而不是只有文字變大。虛擬滾動的列高以 `--row-h` 宣告並由 JS 用 `getComputedStyle` 讀回，所以列高會跟著字級變動，捲動位置不會錯位。

視窗變窄時另有兩個斷點：`900px` 以下縮小側邊欄、隱藏日期的星期副標；`640px` 以下改為上下堆疊（側邊欄在上、編輯區在下）。

## 多語系

介面支援**繁體中文**與**英文**，解鎖畫面右上角的 `EN` / `中` 按鈕可隨時切換，選擇存在 `localStorage`（`fly-diary:lang`），下次啟動自動還原。首次啟動若沒有存過偏好，會讀取系統語言：`en-*` 用英文，其餘一律用繁體中文。

實作在 [`src/i18n.js`](src/i18n.js)，沒有引入任何 npm 套件（前端是純靜態檔、沒有打包步驟）：

- **兩份扁平字典**：`zhHant` 與 `en`，鍵名用點號分層（`lock.subtitle.unlock`、`import.statReady`）。兩份字典的鍵必須完全一致，缺鍵會回退到另一份字典，再退回鍵名本身，不會在畫面上出現 `undefined`。
- **`t(key, params)`**：支援 `{name}` 佔位符，例如 `t("editor.wordCount", { chars, lines })`。
- **`data-i18n` 屬性**：`index.html` 的靜態文字改用 `data-i18n`（textContent）、`data-i18n-title`、`data-i18n-placeholder`、`data-i18n-aria-label` 標記，`applyTranslations()` 一次套用全部。HTML 裡保留中文原文作為 fallback，即使 JS 尚未執行也不會看到空白。
- **日期在地化**：`formatDate` / `formatMonth` / `formatWeekday` 讓日期跟著語言走 —— 中文是 `2026 年 10 月 23 日`、`週五`，英文是 `10/23/2026`、`Fri`。日曆的星期列也由 JS 依語言產生。
- **動態字串**：`main.js` 自己組出來的字（狀態列、字數、匯入報告、解鎖錯誤訊息）全部改走 `t()`。切換語言時 `onLocaleChange` 會觸發 `refreshForLocale()`，重繪日期膠囊、日曆、清單與匯入預覽，不會留下舊語言的殘影。
- **`<html lang>`**：切換時同步更新，讓螢幕閱讀器、斷字與拼字檢查跟著改變。

要新增語言，只需在 `i18n.js` 加一份字典、把語言代碼加進 `LOCALES`，其餘程式不用動。

## 加密設計

### 金鑰階層

```text
密碼 ──Argon2id(salt, 參數)──▶ master key（32 bytes，永不落地）
                                  │
                                  │ AES-256-GCM
                                  ▼
                    wrapped diary key（存於 vault.xml）
                                  │
                                  │ AES-256-GCM
                                  ▼
                              日記檔案
```

- **master key**：由密碼經 Argon2id 派生，只用來包裝 diary key，不直接加密日記。
- **diary key**：隨機 32 bytes，真正用來加密日記。它被 master key 包裝後存進 `vault.xml`。
- 這層間接讓「改密碼」或「升級 KDF 參數」只需要重新包裝 32 bytes，不必重新加密所有日記。

| 項目         | 實作                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| 對稱加密     | AES-256-GCM（`aes-gcm` crate，RustCrypto）                              |
| 金鑰派生     | Argon2id（`argon2` crate），參數存於 `vault.xml`，建立時可調整          |
| 預設參數     | 19 MiB 記憶體、2 次迭代、平行度 1（OWASP 建議值）                       |
| 參數範圍     | 記憶體 8–1024 MiB、迭代 1–16、平行度 1–16                               |
| Salt         | 每個 vault 一組隨機 16 bytes，存於 `vault.xml`                          |
| IV / Nonce   | 每次寫入產生新的隨機 12 bytes，與密文一同存檔                           |
| 完整性       | GCM 認證標籤（16 bytes）附在密文尾端，竄改會解密失敗                    |
| 密碼驗證     | 以 master key 解開 wrapped diary key 即代表密碼正確（GCM 標籤驗證）     |
| 金鑰生命週期 | 只存在 Rust 端記憶體（`Zeroizing<[u8; 32]>`），鎖定或關閉即歸零         |

> ⚠️ **忘記密碼無法救回**：master key 由密碼派生且不落地，沒有後門或回復機制。
> 提高 Argon2id 參數會讓離線暴力破解更困難，但也會讓每次解鎖變慢。

## 檔案格式

每個日記檔（`YYYY-MM-DD.xml`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<diary version="2">
  <date>2026-10-23</date>
  <iv>BASE64(12 bytes)</iv>
  <payload>BASE64(AES-256-GCM ciphertext + tag)</payload>
</diary>
```

`payload` 解密後是 `標題 + "\n" + 內容`，因此**標題與內容都是密文**，未解鎖時無法得知任何日記寫了什麼。
`date` 是唯一的明文欄位，而它本來就已經出現在檔名上。

> 舊版（`version="1"`）檔案把 `<title>` 存成明文、`<content>` 存密文。讀取時仍相容，
> 下次儲存該篇日記就會自動改寫成 `version="2"` 格式。

Vault 檔（`vault.xml`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<vault version="2">
  <kdf>argon2id</kdf>
  <kdf-memory>19456</kdf-memory>
  <kdf-iterations>2</kdf-iterations>
  <kdf-parallelism>1</kdf-parallelism>
  <salt>BASE64(16 bytes)</salt>
  <wrapped-key-iv>BASE64(12 bytes)</wrapped-key-iv>
  <wrapped-key>BASE64(AES-256-GCM ciphertext + tag)</wrapped-key>
</vault>
```

`wrapped-key` 解密後就是 diary key。檔案內沒有任何明文密碼或未包裝的金鑰。

索引檔（`index.xml`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<diary version="2">
  <date>index</date>
  <iv>BASE64(12 bytes)</iv>
  <payload>BASE64(AES-256-GCM ciphertext + tag)</payload>
</diary>
```

`payload` 解密後是每行一筆的 `日期 \t 標題`，用同一把 diary key 加密。
側邊欄列出日記時只要解密這一個檔案，不必逐一解密所有日記檔。

> 舊版（`version="1"`）vault 使用單次 SHA-256 派生金鑰，並以 `<verifier>` 驗證密碼。
> 解鎖舊 vault 時會自動遷移：先以舊金鑰解密所有日記、用新的隨機 diary key 重新加密，
> 最後才改寫 `vault.xml`。若中途失敗，舊 vault 保持原樣，舊密碼仍可解鎖。

## 設定檔

App 的設定與日記本體分開存放。設定檔只記錄**日記資料夾在哪裡**，不含密碼或任何金鑰材料：

- Linux：`~/.config/com.flydiary.app/settings.xml`
- macOS：`~/Library/Application Support/com.flydiary.app/settings.xml`
- Windows：`%APPDATA%\com.flydiary.app\settings.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<settings version="1">
  <diary-dir>/home/user/Documents/diary</diary-dir>
</settings>
```

## 日記儲存位置

**第一次啟動**時，解鎖畫面會要求選擇日記資料夾（可手動輸入或按「瀏覽…」開啟原生選擇器），
預設值為平台的 app data 目錄：

- Linux：`~/.local/share/com.flydiary.app/diary/`
- macOS：`~/Library/Application Support/com.flydiary.app/diary/`
- Windows：`%APPDATA%\com.flydiary.app\diary\`

選定後路徑寫入設定檔，之後每次啟動都從設定檔讀取。App 左下角會顯示實際路徑；
按「路徑」按鈕可重新選擇（會先鎖定日記）。整個資料夾可直接備份，但**沒有密碼就無法還原內容**。

## 開發

### 1. 安裝系統依賴（Linux）

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

### 2. 安裝前端依賴

```bash
npm install
```

### 3. 啟動開發模式

```bash
npm run dev
```

### 4. 執行測試

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

涵蓋加解密 roundtrip、錯誤密碼、密文竄改偵測、XML 序列化與日期驗證。

### 5. 打包

```bash
npm run build
```

## 專案結構

```
fly-diary/
├── src/                    # 前端（純 HTML/JS/CSS）
│   ├── index.html          # 解鎖畫面 + 編輯器（文字以 data-i18n 標記）
│   ├── main.js             # UI 邏輯、自動儲存、invoke 呼叫
│   ├── i18n.js             # 多語系字典、t()、日期在地化
│   └── styles.css
├── src-tauri/              # Rust 後端
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json
│   ├── icons/
│   └── src/
│       ├── main.rs         # 進入點
│       ├── lib.rs          # Tauri commands + 解鎖 session 狀態
│       ├── settings.rs     # 設定檔（日記路徑）讀寫
│       ├── crypto.rs       # 金鑰派生、AES-256-GCM 加解密
│       ├── xml.rs          # XML 序列化 / 解析
│       └── storage.rs      # vault 與加密日記的檔案儲存層
├── package.json
└── README.md
```

## Tauri Commands

| Command                            | 說明                                         |
| ---------------------------------- | -------------------------------------------- |
| `get_settings()`                   | 讀取設定檔（是否已設定、日記路徑、預設路徑） |
| `set_diary_dir(path)`              | 將日記路徑寫入設定檔（需先鎖定）             |
| `pick_diary_dir()`                 | 開啟原生資料夾選擇器，回傳選擇的路徑         |
| `vault_exists()`                   | 是否已建立 vault（判斷首次啟動）             |
| `get_kdf_defaults()`               | 回傳 Argon2id 預設值與可調整範圍             |
| `create_vault(passphrase, kdf?)`   | 建立 vault 並立即解鎖，可指定 KDF 參數       |
| `unlock(passphrase)`               | 驗證密碼，將金鑰載入記憶體                   |
| `lock()`                           | 清除記憶體中的金鑰                           |
| `is_unlocked()`                    | 目前是否已解鎖                               |
| `get_entry(date)`                  | 讀取並解密某天的日記，不存在回 `null`        |
| `save_entry(date, title, content)` | 加密後寫入/覆寫某天的日記                    |
| `delete_entry(date)`               | 刪除某天的日記                               |
| `list_entries()`                   | 列出所有日記（新到舊，需解鎖才能取得標題）   |
| `rebuild_index()`                  | 丟棄 `index.xml` 並重新掃描所有日記重建索引  |
| `pick_import_dir()`                | 開啟原生資料夾選擇器，回傳匯入來源路徑       |
| `scan_import(importDir)`           | 掃描資料夾並分類為可匯入／已存在／失敗，不寫入 |
| `run_import(importDir, dates, overwrite)` | 平行匯入指定日期，回傳成功／略過／失敗報告 |
| `today()`                          | 回傳本地時區的今天日期                       |
| `diary_path()`                     | 回傳日記資料夾絕對路徑                       |

## 設計重點

- **設定與資料分離**：設定檔（`settings.xml`）只存日記路徑，放在平台 config 目錄；日記本體放在使用者指定的資料夾，兩者可分別備份或搬移。
- **路徑驗證**：`settings::validate_diary_dir` 要求絕對路徑且不得為檔案系統根目錄，避免工作目錄變動導致日記「消失」。
- **日期即主鍵**：`storage::validate_date` 同時驗證格式並阻擋路徑穿越（如 `../../etc/passwd`），檔名由日期推導，天然保證一天一篇。
- **標題也加密**：標題與內容打包成同一段明文再加密，`list_entries` 必須持有金鑰才能解出標題；鎖定時側邊欄會清空，避免殘留任何標題。
- **加密索引**：`index.xml` 以同一把 diary key 加密存放所有 `{日期, 標題}`。列出日記時只解密這一個檔案，不必逐一解密上千篇日記；索引缺失或損毀時會自動回退掃描並重建。
- **虛擬滾動**：側邊欄只渲染視窗內可見的列（外加少量 overscan），捲動時以 `index * 列高` 絕對定位。列高由 CSS 的 `--row-h` 決定、JS 用 `getComputedStyle` 讀回，因此字級改變時列高會跟著變，不會出現捲動錯位。即使有上萬篇日記，DOM 節點數也維持在數十個。
- **單一縮放來源**：所有尺寸都是 `rem`，根字級 = 流動 `clamp()` × 使用者倍率。改一個變數就縮放整個介面（含內距、圖示、日曆），不必為每個元件寫縮放邏輯。
- **翻譯與程式分離**：靜態文字用 `data-i18n` 屬性標在 HTML 上，動態文字走 `t()`，字典集中在 `i18n.js`。`main.js` 裡不再有硬編碼的中文字串，新增語言不必碰 UI 邏輯。
- **日期不靠字串拼接**：`formatDate` / `formatMonth` / `formatWeekday` 各自負責一種格式，中文用「年月日」、英文用 `MM/DD/YYYY`，避免把 `年`、`月` 寫死在程式裡。
- **匯入分兩階段**：`scan_import` 只讀不寫，把每個檔案分類成「可匯入／已存在／失敗」並附上原因；使用者確認後才由 `run_import` 寫入。檔名是日期與標題的唯一來源，不是合法 `YYYY-MM-DD` 就判為失敗，不做猜測。
- **檔名即標題**：匯入時 `2026-10-23.txt` 的標題就是 `2026-10-23`，整份檔案（去掉 BOM、統一換行）原封不動成為內容。不從內容偷一行當標題，匯入因此是無損的，標題也永遠是資料夾裡看得到的東西。
- **匯入容錯**：單一檔案失敗不會中斷整批，報告會分別列出成功、略過與失敗的檔案；索引在整批寫完後只重建一次。
- **平行匯入**：掃描與寫入都跑在 rayon 執行緒池上。每個日期對應自己的檔案，讀檔、AES-GCM 加密、寫檔互不競爭，唯一共享的狀態是索引，因此整批只在最後寫一次 `index.xml`（若改用 `write_entry` 逐筆寫，會變成 N 次索引重寫並把整批序列化）。結果依使用者確認的順序折回，報告順序穩定。
- **不卡 UI**：`run_import` 是 `async` 命令，透過 `spawn_blocking` 把整批工作移出主執行緒，並以 `import-progress` 事件回報 `{done, total}`，對話框按鈕會顯示「匯入中… 12/340」。
- **金鑰階層**：密碼只派生 master key，master key 只包裝隨機的 diary key。改密碼或升級 KDF 時只需重新包裝 diary key，不必動到任何日記檔。
- **可調 KDF**：首次建立 vault 時可在「進階選項」調整 Argon2id 的記憶體／迭代／平行度，參數寫入 `vault.xml`，之後解鎖沿用同一組參數。
- **金鑰不落地**：金鑰只存在 `Mutex<Session>` 中並以 `Zeroizing` 包裝，`lock()` 或程式結束即抹除。
- **本地時區**：`today()` 用 `chrono::Local`，前端日期運算也用本地 `Date`，避免 UTC 跨日問題。
- **資料安全**：自動儲存 + 切換日期前強制存檔 + 鎖定前強制存檔。

## 已知限制

- 日期為明文（檔名與 `<date>`），但標題與內容皆已加密。
- 尚未提供修改密碼功能（有了金鑰階層後，只需重新包裝 diary key，但 UI 尚未實作）。
- 舊版（SHA-256）vault 會在解鎖時自動遷移，遷移期間需要重新加密所有日記，日記量大時會較慢。
- `index.xml` 與日記檔分開寫入，若程式在兩次寫入之間被強制終止，索引可能落後；下次寫入或呼叫 `rebuild_index()` 即可修復。
- 匯入只讀取資料夾第一層的 `.txt`，不遞迴子資料夾；單檔上限 8 MiB，且必須是 UTF-8。
- 平行匯入的加速幅度受磁碟限制：SSD 上通常快 2–4 倍，傳統硬碟或網路磁碟可能幾乎沒有差異（甚至因 seek 而略慢）。
- 匯入時標題固定取自檔名（`YYYY-MM-DD`），檔案內容全部視為日記本文；若想要自訂標題，匯入後再手動修改即可。
- 目前只有繁體中文與英文兩種語言；後端回傳的錯誤訊息（例如 Rust 端的 `Failed to write entry ...`）仍是英文，尚未翻譯。
- 變更日記路徑不會搬移既有檔案，需自行複製；新路徑若已有 vault 則會沿用該 vault 的密碼。
- 設定檔本身未加密，任何人可讀到日記資料夾位置（但沒有密碼仍無法解密內容）。
