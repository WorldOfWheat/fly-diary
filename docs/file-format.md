# 檔案格式與儲存位置

[← 回到 README](../README.md) · [文件索引](README.md)

這一頁說明日記、索引、附件、manifest 與設定檔的實際格式，以及日記資料夾的位置與切換方式。

## 格式版本與相容性

`2.2.0` 是第一個正式版。下列格式版本自 `2.2.0` 起視為穩定；App 版號與格式版本彼此獨立。

| 格式                         | 目前版本           | 讀取相容 | 說明                            |
| ---------------------------- | ------------------ | -------- | ------------------------------- |
| 日記 entry（legacy XML）     | `version="5"`      | v1–v5    | 只作為一次性遷移輸入，不再寫入  |
| `vault.xml`                  | `version="3"`      | v1–v3    | v1／v2 解鎖時自動升級           |
| `recovery.xml`               | `version="2"`      | v1–v2    | v1 在下次成功復原時升級         |
| `settings.xml`               | `version="3"`      | v1–v3    | 缺少欄位套用預設值              |
| SQLCipher schema             | `user_version = 1` | 僅 1     | 較新的 schema 會被拒絕          |
| 附件 sidecar                 | `FDAT` v3          | v1–v3    | 新附件使用 v3／`attachment_key` |
| 附件 manifest（legacy XML）  | `version="2"`      | v1–v2    | 新資料存 DB，不再寫 XML         |

規則：

- 讀取端接受表中列出的舊版本；寫入端一律寫目前版本。
- 只有在 payload 或 AAD 不相容時才遞增格式版本；不要因為 App 改版就重設格式版本。
- 舊格式升級是單向的：升級後不保證舊版 App 能讀取；請保留備份再升級。

## 檔案格式

> **SQLCipher 版本的重要變更**：除了 `vault.xml` 與 `recovery.xml`，本文件描述的
> 日記 XML 格式**只作為一次性遷移的 legacy 參考**。新版本不再產生
> `YYYY-MM-DD.xml`、`index.xml` 或 `manifest.xml`；完整的新格式、
> 加密備份 `.tar` 與遷移流程請見 [sqlcipher.md](sqlcipher.md)。

每個 legacy 日記檔（`YYYY-MM-DD.xml`，只作為遷移輸入）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<diary version="5">
  <date>2026-10-23</date>
  <iv>BASE64(12 bytes)</iv>
  <payload>BASE64(AES-256-GCM ciphertext + tag)</payload>
</diary>
```

`payload` 解密後是 `\x01` + 收藏旗標（`1` / `0`）+ `"\n"` + `標題` + `"\n"` + `內容`，
因此**標題、內容與收藏狀態都是密文**，未解鎖時無法得知任何日記寫了什麼。
在日記檔內，`date` 是唯一的明文欄位，而它本來就已經出現在檔名上。附件是另一個 sidecar，
會額外露出日期資料夾、圖片張數與檔案大小，但圖片內容、原始檔名與 manifest 都是密文。

### 版本與 AAD

`version="5"` 的 payload 使用 AES-GCM 的 **associated data（AAD）**，綁定：

- domain label `fly-diary/aad/v5`
- object kind（entry／index／manifest／attachment／recovery／vault-wrap）
- `vault-id` 與 `key-id`（各 16 bytes）
- 日期、附件 id（依 object 而定）
- 文件版本

所有欄位都以長度前綴串接，避免欄位邊界歧義。這擋掉：

1. **搬檔**：把日記複製成另一個日期會解密失敗。
2. **降級**：把 `version="5"` 改寫成 4／3／2 會讓 AAD 不符。
3. **跨 vault 搬移**：把密文搬到另一個日記本，即使日期相同也會失敗。
4. **物件互換**：entry、index、manifest、attachment、recovery 的 kind 不同。

舊格式仍可讀：

| 版本 | payload 內容                              | AAD                                                           |
| ---- | ----------------------------------------- | ------------------------------------------------------------- |
| `4`  | `\x01` + 旗標 + `\n` + 標題 + `\n` + 內容 | `日期 \|\| 0x00 \|\| 版本`（日記）／`fly-diary/index`（索引） |
| `3`  | `\x01` + 旗標 + `\n` + 標題 + `\n` + 內容 | 日期（日記）／`fly-diary/index`（索引）                       |
| `2`  | 標題 + `\n` + 內容（無旗標，視為未收藏）  | 無                                                            |
| `1`  | `<title>` 明文、`<content>` 密文          | 無                                                            |

> 舊版 `version="2"` 沒有收藏旗標；`version="1"` 把 `<title>` 存成明文。`version="3"` 只綁日期、
> 沒有把版本號納入 AAD。三者都仍可讀取，下次儲存或背景升級時會改寫成 `version="5"`。

#### 解鎖後自動升級格式

除了「寫到哪篇就升級哪篇」的懶惰升級，每次解鎖成功後都會在**背景**跑一次全庫升級，
把還停在 `version="1"` / `version="2"` / `version="3"` / `version="4"` 的日記一次改寫成 `version="5"`：

- 由 `enterApp()` 觸發，**不 await**：日記立刻可用，升級在 `spawn_blocking` 裡跑，
  不會讓使用者盯著編輯器等整個資料夾改寫完。
- 進度透過 `upgrade-progress` 事件回報 `(done, total)`，狀態列顯示「正在升級日記格式… 12/340」；
  結束後顯示「已升級 N 篇」或「已升級 X 篇，Y 篇失敗（原檔未更動）」。
- **冪等**：已經是 `version="5"` 的檔案直接跳過，所以中斷後下次解鎖會自動續跑，
  也不會每次解鎖都重寫整個資料夾。
- **原子替換**：先寫到 `YYYY-MM-DD.xml.upgrade`（同樣 `0600`），再 `rename` 覆蓋原檔。
  POSIX 的 `rename` 是原子的，中途斷電只會留下舊檔或新檔，不會有半截檔案。
- **寫入前驗證**：新密文會立刻用同一把金鑰解回來，必須與原本的明文**位元組完全相同**才准寫入。
- **不覆蓋使用者的編輯**：讀檔前先記下 mtime，`rename` 前再比對一次；若期間使用者存了檔，
  就丟棄暫存檔並跳過該篇，讓下一次解鎖再處理。
- **壞檔不動**：無法解析或解不開的檔案不會進入升級清單，原始位元組完整保留，仍可從「損壞」分類匯出。
- **v1 標題不遺失**：`version="1"` 的標題存在明文的 `<title>` 裡，升級時會先把它併進 payload
  再加密，因此升級後標題仍然存在，而且不再以明文落地。
- 升級只改寫日記檔，**不動 `index.xml`**：標題與收藏旗標都沒變，索引內容因此仍然正確。

Vault 檔（`vault.xml`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<vault version="3">
  <kdf>argon2id</kdf>
  <kdf-memory>65536</kdf-memory>
  <kdf-iterations>3</kdf-iterations>
  <kdf-parallelism>1</kdf-parallelism>
  <vault-id>BASE64(16 bytes)</vault-id>
  <key-id>BASE64(16 bytes)</key-id>
  <salt>BASE64(16 bytes)</salt>
  <wrapped-key-iv>BASE64(12 bytes)</wrapped-key-iv>
  <wrapped-key>BASE64(AES-256-GCM ciphertext + tag)</wrapped-key>
</vault>
```

`wrapped-key` 解密後就是 diary key；v3 的包裝 AAD 另外綁定 `vault-id`、`key-id`、salt 與 KDF 參數。檔案內沒有任何明文密碼或未包裝的金鑰。v2 vault 沒有兩個 id，首次解鎖時會原子升級成 v3；舊 entry 仍可透過 v4 AAD 讀取，下次儲存再改寫成 v5。

### 回復短語檔（`recovery.xml`）

啟用回復短語後，日記資料夾會多一個 sidecar：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<recovery version="2">
  <iv>BASE64(12 bytes)</iv>
  <wrapped-key>BASE64(AES-256-GCM ciphertext + tag)</wrapped-key>
</recovery>
```

- `wrapped-key` 是用 recovery key 包裝的 diary key；recovery key 由 12 個 BIP39 英文單字解碼出的 128-bit 熵，經 domain-separated SHA-256 展成 32 bytes。
- v2 AAD 綁定 `vault-id`、`key-id`、object kind 與版本；把 blob 搬到別的日記本會直接解密失敗。舊 v1 仍可讀，但沒有 id；復原成功後會自動改寫成 v2。
- **刻意放在 `vault.xml` 之外**：舊版 App 改密碼或 KDF 參數時，會用固定欄位重建 `vault.xml`，不認識的欄位會被丟掉。獨立檔案不會被舊版覆寫；而 diary key 在改密碼時不變，所以短語持續有效。
- 寫入同樣走 `write_private`（`0600`、先寫暫存檔再 rename），失敗不會留下半截檔案。
- 重新產生短語會用新短語覆寫此檔；停用短語會刪除此檔。兩者都不會重新加密日記。
- 用短語復原時只改寫 `vault.xml`（新 salt、新 master key 包裝同一把 diary key），此檔保持不變，所以短語仍然有效。
- 備份必須包含這個檔案；只複製 `vault.xml` 與日記檔會讓短語失效。

legacy 索引檔（`index.xml`，新版本不再產生）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<diary version="5">
  <date>index</date>
  <iv>BASE64(12 bytes)</iv>
  <payload>BASE64(AES-256-GCM ciphertext + tag)</payload>
</diary>
```

`payload` 解密後是每行一筆的 `日期 \t 標題 \t 收藏旗標`，用同一把 diary key 加密。
v5 索引的 AAD 使用 `index` object kind 加上 `vault-id`／`key-id`；舊索引仍用 `b"fly-diary/index"`，因此索引密文與日記密文不能互換。
側邊欄列出日記時只要解密這一個檔案，不必逐一解密所有日記檔。

> 索引只是**快取**：`index.xml` 遺失或損毀時，會改為掃描所有日記檔重建。
> 收藏旗標的權威來源是日記檔內的密文，索引只是鏡射一份，所以重建索引不會弄丟收藏。
> 沒有第三欄的舊索引（`日期 \t 標題`）仍可讀取，一律視為未收藏。

附件檔（`attachments/<id>.bin`；舊版為 `attachments/YYYY-MM-DD/<id>.bin`）是二進位加密檔，不經過 XML／base64：

```text
magic "FDAT" | version u8 | IV 12 bytes | AES-256-GCM ciphertext + tag
```

MIME 與顯示順序存在 SQLCipher；legacy 遷移時仍會讀取資料夾內的 `manifest.xml`。
manifest 遺失時，解密後可由 magic bytes 重新判斷 MIME。圖片不會出現在
`list_entries`，DB 的 `entries` 與 `attachments` 是分開的。

> 舊版（`version="1"`）vault 使用單次 SHA-256 派生金鑰，並以 `<verifier>` 驗證密碼。
> 解鎖舊 vault 時會自動遷移：先以舊金鑰解密所有日記、用新的隨機 diary key 重新加密，
> 最後才改寫 `vault.xml`。若中途失敗，舊 vault 保持原樣，舊密碼仍可解鎖。

### 損壞的日記檔

掃描日記資料夾時，任何無法完整解讀的 `YYYY-MM-DD.xml` 都會被歸類為**損壞**，
而不是讓整個清單載入失敗。判定順序與對應原因：

| 原因             | 觸發條件                                                                    |
| ---------------- | --------------------------------------------------------------------------- |
| `unreadable`     | 檔案讀不出來（權限、I/O 錯誤）                                              |
| `malformed_xml`  | 不是合法的 XML，或缺 `date` / `iv` / `payload`                              |
| `bad_encoding`   | `iv` 或 `payload` 不是合法的 Base64                                         |
| `decrypt_failed` | GCM 驗證失敗：金鑰不符、內容被改過，或**日期與 AAD 對不上**（例如手動搬檔） |

損壞的檔案**不會進入索引**，也**不會出現在「全部」清單**，因此側邊欄的日記數不會被污染。
只有在真的存在損壞檔時，側邊欄才會多出一個「損壞」分類（帶數字徽章），
點進去可以看到每一筆的日期、原因與檔案大小。

點開損壞的日記時，編輯器會進入**唯讀鎖定**狀態：

- 標題與內容清空並停用，不會載入任何（可能是錯的）內容
- 上方出現紅色提示列，說明無法解密的原因
- 自動儲存與手動儲存都會被跳過，所以**不可能用空白內容覆蓋掉原始檔案**
- 可以自由切換到其他日期，切回來時仍然是鎖定狀態

處理方式只有兩種：

1. **匯出備份** — 把原始 `.xml` 以**位元組為單位**複製到使用者選擇的位置，
   不重新序列化，因此未知的元素與屬性都會原樣保留，方便事後人工搶救。
2. **刪除檔案** — 需要二次確認，且訊息會明講無法復原。

匯出成功後會再問一次是否要刪除，讓使用者自己決定；不匯出也可以直接刪除。
刪除走的是既有的 `delete_entry`，同時會把該日期從索引與附件資料夾移除。

## 圖片附件

圖片是日記的 **sidecar**，不是 entry payload 的一部分。文字格式完全不變，
所以舊日記不需要遷移，新舊版本也能互相讀取：

```text
diary/
├── 2026-10-23.xml
└── attachments/
    ├── 9f2c1a7b4e6d8c039f2c1a7b4e6d8c03.bin
    └── 4d8e2f1a6b3c9e704d8e2f1a6b3c9e70.bin
```

舊版 vault 可能還有 `attachments/2026-10-23/<id>.bin` 與 `manifest.xml`；讀取時會
fallback 到日期資料夾，設定頁的「更新舊圖片」會把檔案搬進扁平的 `attachments/`。

- **檔名**：16 bytes 隨機 → 32 個小寫 hex + `.bin`，由後端產生。不使用原始檔名、標題、
  日期或 SHA-256，避免洩漏與路徑問題。
- **每張圖獨立加密**：AES-256-GCM，新的隨機 12-byte IV。檔案格式為
  `FDAT | version | IV | ciphertext`；v2 AAD 綁定 `vault-id`／`key-id`／日期／id／版本，舊 v1 使用舊 label。
- **manifest.xml（legacy only）**：外層沿用日記的 `<diary version="5">` envelope，payload 解密後是內層 XML：

  ```xml
  <manifest version="2" date="2026-10-23">
    <attachment id="9f2c..." mime="image/webp" width="1000" height="750"/>
    <attachment id="4d8e..." mime="image/jpeg" width="800" height="1000"/>
  </manifest>
  ```

  **元素順序就是顯示順序**。沒有 `added-at`，也不依賴檔名或 mtime。
  v5 manifest 的 AAD 綁定 `vault-id`／`key-id`／日期／版本；舊 manifest 使用 `"fly-diary/attachment-manifest" || 0x00 || date`，
  所以搬到別天會失敗，也不能和 `index.xml` 或日記密文互換。
- **上傳前壓縮**：前端只負責讀取原始 bytes，`prepare_image` 在 Rust 後端解碼、套用 EXIF 方向、
  將長邊縮到 1000px，再以有損 WebP（libwebp，quality 80）重新編碼。輸出固定是 `image/webp`，
  不再依賴 WebView 的 canvas 編碼能力；重新編碼會一併清掉其他 EXIF（包含 GPS）。
- **更新舊圖片**：設定頁的「更新舊圖片」會掃描所有附件，把 legacy 日期資料夾的檔案搬進扁平的
  `attachments/`，並把 PNG／JPEG／無損 WebP 重新編碼為有損 WebP。只有省下至少 10% 才取代原檔；
  已經是 lossy WebP 的檔案只搬移、不重新編碼，避免世代失真。重新編碼是就地覆寫且不可還原，
  執行前會提示先備份。
- **限制**：前端輸入上限 64 MiB；後端解碼後上限 5 MB、每天最多 200 張。輸入可為
  WebP / JPEG / PNG / GIF / BMP / TIFF，拒絕 SVG；新寫入的附件一律是 WebP，讀取舊檔時
  `mime` 與 magic bytes 必須一致。
- **加入方式**：除了「加入圖片」按鈕，也可以直接把圖片檔拖進編輯區，或把剪貼簿裡的圖片
  （例如截圖）貼上。只有真正的圖片檔會被攔截，文字貼上與相簿內部的排序拖曳不受影響。
  桌面版的檔案拖放走 Tauri 原生事件（`onDragDropEvent`）：它提供的是**檔案路徑**，由
  `read_dropped_images` 讀成 base64 後，再交給與檔案選擇器相同的壓縮與加密流程。
  這是刻意的：Linux／WebKitGTK 的 HTML5 `drop` 常常只給 `text/uri-list`、`dataTransfer.files`
  是空的，只靠前端會出現「有拖放提示、放開卻沒有加入」的情況。HTML5 handler 仍保留作為
  其他 webview 的備援。原生拖放事件只在桌面版使用；行動版仍以檔案選擇器為主。
- **貼上圖片**：貼上事件沒有帶 `File` 時，會改用 `read_clipboard_image` 從系統剪貼簿讀取圖片
  （arboard），再走同一套壓縮流程。這補上 WebKitGTK 不把剪貼簿圖片放進 `clipboardData`
  的情況；純文字貼上仍完全交給瀏覽器，不會被攔截。只有剪貼簿真的含圖片時才會自動解鎖唯讀日記。
  原生剪貼簿備援只在桌面版啟用；行動版仍走 WebView 的 paste 事件。
- **讀取**：`list_attachments` 只解密 manifest；`get_attachment` 才逐張解密，前端延遲載入。
  剛上傳的圖片直接沿用後端已壓縮的 bytes 顯示縮圖，不必等後端再解密一次。
- **唯讀與壞檔**：唯讀模式只能看圖；按鈕新增、刪除、排序都要先「解鎖編輯」。貼上或拖放圖片
  被視為明確的編輯動作，會自動解鎖一般唯讀日記並繼續加入；壞檔（`lockedDate`）仍完全鎖定，
  只顯示提示。

### 順序與一致性

新增圖片時依序做「確保 entry 存在 → 寫圖片 → 寫 manifest」；刪除時依序做
「刪圖片 → 更新 manifest」。這個方向讓 crash 的結果只會是：

- 新增中斷 → 留下未被 manifest 引用的扁平圖片，可由孤兒清理處理。
- 刪除中斷 → manifest 指向不存在的圖片，顯示「圖片遺失」佔位，不會讓已刪除的圖復活。

manifest 現在只存在 SQLCipher 的 `attachments` 表；不再有 `manifest.xml`。
扁平檔名不含日期，DB rows 遺失時無法從檔名重建日期；只有 legacy 日期資料夾的
`*.bin` 還能靠掃描該日期重建（順序退回 mtime／檔名）。沒有 `entries` 列的 legacy
日期資料夾，以及沒有 `attachments` 列引用的扁平 `*.bin`，都視為孤兒：可用
`list_orphan_attachments` 列出、`delete_orphan_attachments` 確認後刪除（扁平孤兒的
`date` 是空字串），不會自動刪除。

刪除日記的順序是 **先記下 attachment ids → DB（entries 與 attachment rows 明確刪除）
→ 依 ids 刪除扁平檔案與 legacy 日期資料夾**；反過來先刪附件會在 crash 時留下
「日記還在、圖片沒了」的更糟狀態。

## 設定檔

App 的設定與日記本體分開存放。設定檔只記錄**日記資料夾在哪裡**、**閒置自動鎖定的分鐘數**
與**自動儲存的延遲毫秒數**，不含密碼或任何金鑰材料：

- Linux：`~/.config/com.flydiary.app/settings.xml`
- macOS：`~/Library/Application Support/com.flydiary.app/settings.xml`
- Windows：`%APPDATA%\com.flydiary.app\settings.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<settings version="3">
  <diary-dir>/home/user/Documents/diary</diary-dir>
  <auto-lock-minutes>10</auto-lock-minutes>
  <autosave-delay-ms>800</autosave-delay-ms>
</settings>
```

`auto-lock-minutes` 只接受 `0`（永不）、`1`、`5`、`10`、`15`、`30`、`60`，其他值會被拒絕。
`autosave-delay-ms` 只接受 `200`、`400`、`800`、`1500`、`3000`，其他值（包含 `0`）會被拒絕。
缺少元素時自動套用預設值（分別是 10 分鐘與 800 毫秒），下次寫入即升級為 `version="3"`；
但元素存在而內容不合法時會直接報錯，不會默默改成預設值。

### 加密備份（`.tar`）

`export_backup` 產生的備份是未壓縮的 tar，沒有額外的 manifest 檔，結構固定：

```text
diary.db                     # VACUUM INTO 快照（SQLCipher 密文）
vault.xml                    # Argon2id 包裝的 diary key
recovery.xml                 # 選用；有啟用回復短語時才存在
attachments/<32 hex>.bin
```

- 備份一律使用扁平附件路徑；舊備份的 `attachments/YYYY-MM-DD/<id>.bin` 仍可匯入，
  解壓時會正規化成扁平路徑（日期已存在 DB 快照）。
- 檔名建議為 `fly-diary-backup-YYYY-MM-DD.tar`，但 App 不依賴檔名。
- `diary.db` 是 `VACUUM INTO` 的輸出，等同一致快照；不含 `-wal`／`-shm`。
- `vault.xml` 與 `recovery.xml` 讓備份在 App 無法解鎖時仍可手動救援。
- 解壓時只接受上述路徑；`..`、絕對路徑、重複路徑、非預期檔名與超過大小上限的
  項目都會被拒絕。
- **還原**（設定 → 備份）只替換 `diary.db` 與 `attachments/`，舊資料移至
  `<diary>.local-backup-<timestamp>`；它要求備份屬於目前解鎖的同一個 vault，
  且不會覆寫目前的 `vault.xml`／`recovery.xml`。
- **匯入**（設定 → 資料移轉，或第一次啟動的解鎖畫面）會用備份的密碼解開
  `vault.xml`，驗證資料庫後把 `vault.xml`、`recovery.xml`、`diary.db` 與
  `attachments/` 一起安裝；舊 vault（含金鑰包裝檔）會先移到
  `<diary>.local-backup-<timestamp>`。這適合換裝置或在 App 資料被清除後重建。
- `biometric.json` 是裝置綁定的 Android Keystore 包裝，**不會進 `.tar`**；匯入新 vault 時會跟舊的 `vault.xml`／`recovery.xml` 一起移到 `*.local-backup-*`。
- `diary.db-wal`、`diary.db-shm`、`migration.journal` 與暫存檔不會進備份。
- 備份、還原與匯入都不是同步：沒有三方比較、衝突清單、自動上傳或變更合併。

## 日記儲存位置

**第一次啟動**時，解鎖畫面會要求選擇日記資料夾（可手動輸入或按「瀏覽…」開啟原生選擇器），
預設值為平台的 app data 目錄：

- Linux：`~/.local/share/com.flydiary.app/diary/`
- macOS：`~/Library/Application Support/com.flydiary.app/diary/`
- Windows：`%APPDATA%\com.flydiary.app\diary\`

選定後路徑寫入設定檔，之後每次啟動都從設定檔讀取。目前路徑顯示在設定頁的「日記本」區塊，
按那裡的「路徑」按鈕可重新選擇（會先鎖定日記）。資料夾內是 `diary.db`、`vault.xml`、
`recovery.xml`、選用的 `biometric.json`（Android 裝置綁定）與 `attachments/`；備份請先鎖定日記，再複製整個資料夾，不要只複製執行中的
`diary.db`。**沒有密碼或回復短語就無法還原內容**；只複製 `diary.db` 也打不開，因為 DB key
來自 `vault.xml` 裡包裝的 diary key。

行動版（Android／iOS）沒有檔案系統資料夾選擇器，日記固定存放在 App 私有資料夾：解鎖畫面只在
第一次啟動時顯示唯讀路徑，不提供「瀏覽…」或「切換工作區」；設定頁也不顯示變更路徑按鈕。
備份檔可透過系統檔案選擇器存到 SAF 可寫入的位置；第一次啟動或設定 → 資料移轉也能從
`.tar` 匯入，不需要先手動把檔案放進 App 私有資料夾。

### 切換工作區

解鎖畫面上，已設定的資料夾會顯示在密碼欄上方，右側是「切換工作區」按鈕。按下後路徑欄位展開
（預填目前路徑），可手動輸入或按「瀏覽…」選資料夾：

- 選到的資料夾**已有 vault** → 版面立刻切成「輸入密碼」，直接解鎖那個日記本
- 選到的資料夾**是空的** → 版面切成「設定密碼」，在那裡建立新的 vault
- 按「取消」→ 路徑還原成設定檔裡的值，回到原本的解鎖表單

路徑要按下解鎖／建立才會寫入設定檔，所以中途放棄不會讓 App 指向一個打不開的資料夾。
設定頁「日記本」區塊的「路徑」按鈕走的是同一條流程：先鎖定，再開啟同一個選擇器。

若選到的新資料夾**已經有 vault**（例如從備份還原、或切換回舊的日記夾），App 會直接跳到解鎖畫面，
要求輸入**那個 vault 的密碼**，而不是顯示「建立新日記」的表單。這樣就不會誤以為要重新設定密碼，
也不會不小心覆蓋既有資料。
