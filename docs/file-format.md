# 檔案格式與儲存位置

[← 回到 README](../README.md) · [文件索引](README.md)

這一頁說明日記、索引、附件、manifest 與設定檔的實際格式，以及日記資料夾的位置與切換方式。

## 檔案格式

每個日記檔（`YYYY-MM-DD.xml`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<diary version="4">
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

`version="4"` 的 payload 以 AES-GCM 的 **associated data（AAD）** 綁定到它所屬的日期**與版本號**：

```
AAD = date || 0x00 || version
```

加密時把這段位元組當成 AAD 傳入，解密時再傳一次。AAD 會被 GCM 的驗證標籤涵蓋但不被加密，
所以只要日期或版本對不上，解密就會失敗。中間的 `0x00` 是分隔符，確保
`("2026-10-2", 34)` 與 `("2026-10-23", 4)` 不會拼出同一段 AAD。

這擋掉兩種攻擊：

1. **搬檔**：把 `2026-10-23.xml` 複製成 `2026-10-24.xml`。在沒有 AAD 的舊格式下會安靜地顯示
   10/23 的內容（因為 `read_entry` 回傳的是**被要求的**日期），現在會直接解密失敗。
2. **降級**：把 `<diary version="4">` 改寫成 `version="3"` 或 `version="2"`，誘導讀取端改用
   較弱（或完全沒有）的 AAD 來解密，再搭配搬檔把別天的密文塞進來。因為版本號本身也在 AAD 裡，
   改寫版本屬性會讓驗證標籤失效，該篇日記會被歸類為**損壞**而不是被安靜地解開。

同理，`index.xml` 用 `b"fly-diary/index"` 當 AAD，所以索引密文與日記密文即使使用同一把
diary key 也**不能互換**。附件也各自使用獨立 label：圖片是
`fly-diary/attachment || 0x00 || 日期 || 0x00 || id || 0x00 || 版本`，manifest 是
`fly-diary/attachment-manifest || 0x00 || 日期`；因此圖片、manifest、索引與日記四種密文
彼此都不能互換，附件搬到別的日期也會解密失敗。

| 版本 | payload 內容                              | AAD                                                           |
| ---- | ----------------------------------------- | ------------------------------------------------------------- |
| `4`  | `\x01` + 旗標 + `\n` + 標題 + `\n` + 內容 | `日期 \|\| 0x00 \|\| 版本`（日記）／`fly-diary/index`（索引） |
| `3`  | `\x01` + 旗標 + `\n` + 標題 + `\n` + 內容 | 日期（日記）／`fly-diary/index`（索引）                       |
| `2`  | 標題 + `\n` + 內容（無旗標，視為未收藏）  | 無                                                            |
| `1`  | `<title>` 明文、`<content>` 密文          | 無                                                            |

> 舊版（`version="2"`）payload 是 `標題 + "\n" + 內容`，沒有收藏旗標，讀取時視為「未收藏」；
> 更舊的 `version="1"` 把 `<title>` 存成明文、`<content>` 存密文。`version="3"` 只綁日期、
> 沒有把版本號納入 AAD，因此仍可被降級改寫。三者都仍可讀取，讀取時依文件上的 `version`
> 決定要帶哪一種 AAD，下次儲存該篇日記就會自動改寫成 `version="4"`。
> 舊 vault 遷移時也會一併把日記改寫成版本綁定的格式。

#### 解鎖後自動升級格式

除了「寫到哪篇就升級哪篇」的懶惰升級，每次解鎖成功後都會在**背景**跑一次全庫升級，
把還停在 `version="1"` / `version="2"` / `version="3"` 的日記一次改寫成 `version="4"`：

- 由 `enterApp()` 觸發，**不 await**：日記立刻可用，升級在 `spawn_blocking` 裡跑，
  不會讓使用者盯著編輯器等整個資料夾改寫完。
- 進度透過 `upgrade-progress` 事件回報 `(done, total)`，狀態列顯示「正在升級日記格式… 12/340」；
  結束後顯示「已升級 N 篇」或「已升級 X 篇，Y 篇失敗（原檔未更動）」。
- **冪等**：已經是 `version="4"` 的檔案直接跳過，所以中斷後下次解鎖會自動續跑，
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
<diary version="4">
  <date>index</date>
  <iv>BASE64(12 bytes)</iv>
  <payload>BASE64(AES-256-GCM ciphertext + tag)</payload>
</diary>
```

`payload` 解密後是每行一筆的 `日期 \t 標題 \t 收藏旗標`，用同一把 diary key 加密，
但 AAD 是 `b"fly-diary/index"` 而不是日期，因此索引密文與日記密文不能互換。
側邊欄列出日記時只要解密這一個檔案，不必逐一解密所有日記檔。

> 索引只是**快取**：`index.xml` 遺失或損毀時，會改為掃描所有日記檔重建。
> 收藏旗標的權威來源是日記檔內的密文，索引只是鏡射一份，所以重建索引不會弄丟收藏。
> 沒有第三欄的舊索引（`日期 \t 標題`）仍可讀取，一律視為未收藏。

附件檔（`attachments/YYYY-MM-DD/<id>.bin`）是二進位加密檔，不經過 XML／base64：

```text
magic "FDAT" | version u8 | IV 12 bytes | AES-256-GCM ciphertext + tag
```

MIME 與顯示順序存在同資料夾的 `manifest.xml`；manifest 遺失時，解密後可由 magic bytes
重新判斷 MIME。圖片與 manifest 都不會出現在 `list_entries`，因為掃描只處理頂層的
`YYYY-MM-DD.xml`。

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
    └── 2026-10-23/
        ├── manifest.xml
        ├── 9f2c1a7b4e6d8c039f2c1a7b4e6d8c03.bin
        └── 4d8e2f1a6b3c9e704d8e2f1a6b3c9e70.bin
```

- **檔名**：16 bytes 隨機 → 32 個小寫 hex + `.bin`，由後端產生。不使用原始檔名、標題、
  日期或 SHA-256，避免洩漏與路徑問題。
- **每張圖獨立加密**：AES-256-GCM，新的隨機 12-byte IV。檔案格式為
  `FDAT | version | IV | ciphertext`，AAD 是
  `"fly-diary/attachment" || 0x00 || date || 0x00 || id || 0x00 || version`。
- **manifest.xml**：外層沿用日記的 `<diary version="4">` envelope，payload 解密後是內層 XML：

  ```xml
  <manifest version="1" date="2026-10-23">
    <attachment id="9f2c..." mime="image/webp" width="1000" height="750"/>
    <attachment id="4d8e..." mime="image/jpeg" width="800" height="1000"/>
  </manifest>
  ```

  **元素順序就是顯示順序**。沒有 `added-at`，也不依賴檔名或 mtime。
  manifest 的 AAD 是 `"fly-diary/attachment-manifest" || 0x00 || date`，
  所以搬到別天會失敗，也不能和 `index.xml` 或日記密文互換。
- **上傳前壓縮**：前端用 canvas 將長邊縮到 1000px、WebP quality 0.8；若 WebView 不支援
  WebP 編碼時，PNG／WebP 來源會 fallback PNG 以保留透明，其他來源 fallback JPEG（透明區填白）。
  重新編碼會一併清掉 EXIF（包含 GPS）。
- **限制**：前端輸入上限 20 MB；後端解碼後上限 5 MB、每天最多 200 張；只接受
  WebP / JPEG / PNG，拒絕 SVG。`mime` 與 magic bytes 必須一致。
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
  剛上傳的圖片直接沿用前端已壓縮的 bytes 顯示縮圖，不必等後端再解密一次。
- **唯讀與壞檔**：唯讀模式只能看圖；按鈕新增、刪除、排序都要先「解鎖編輯」。貼上或拖放圖片
  被視為明確的編輯動作，會自動解鎖一般唯讀日記並繼續加入；壞檔（`lockedDate`）仍完全鎖定，
  只顯示提示。

### 順序與一致性

新增圖片時依序做「確保 entry 存在 → 寫圖片 → 寫 manifest」；刪除時依序做
「刪圖片 → 更新 manifest」。這個方向讓 crash 的結果只會是：

- 新增中斷 → 留下未被 manifest 引用的圖片，下次載入時補到最後。
- 刪除中斷 → manifest 指向不存在的圖片，顯示「圖片遺失」佔位，不會讓已刪除的圖復活。

manifest 遺失或損壞時，會掃描該日期的 `*.bin` 重建，順序退回 mtime／檔名；
資料不會不見，但精確順序只能近似恢復。整個日期資料夾沒有對應 XML 時視為孤兒，
可用 `list_orphan_attachments` 列出、`delete_orphan_attachments` 確認後刪除，不會自動刪除。

刪除日記的順序是 **index → XML → 附件資料夾**；反過來先刪附件會在 crash 時留下
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

## 日記儲存位置

**第一次啟動**時，解鎖畫面會要求選擇日記資料夾（可手動輸入或按「瀏覽…」開啟原生選擇器），
預設值為平台的 app data 目錄：

- Linux：`~/.local/share/com.flydiary.app/diary/`
- macOS：`~/Library/Application Support/com.flydiary.app/diary/`
- Windows：`%APPDATA%\com.flydiary.app\diary\`

選定後路徑寫入設定檔，之後每次啟動都從設定檔讀取。目前路徑顯示在設定頁的「日記本」區塊，
按那裡的「路徑」按鈕可重新選擇（會先鎖定日記）。整個資料夾可直接備份，但**沒有密碼就無法還原內容**。

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
