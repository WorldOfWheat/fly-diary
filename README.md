# Fly Diary

一個用 Tauri 2 寫的極簡加密日記 App：**一天只會有一篇**，以 **AES-256-GCM 加密的 XML** 檔案儲存。

## 功能

- 一天一篇：檔名即日期（`YYYY-MM-DD.xml`），同一天再存只會覆寫，不會產生重複
- **AES-256-GCM 加密**：日記內容以 RustCrypto 的 `aes-gcm` 加密，每次寫入使用新的隨機 IV
- **首次啟動設定儲存路徑**：可自訂日記資料夾（含原生資料夾選擇器），路徑寫入設定檔
- **解鎖畫面可切換工作區**：不必先解鎖就能改用另一個日記資料夾；若該資料夾已有 vault，直接切換成輸入密碼
- **密碼保護**：首次啟動設定密碼，之後每次開啟需解鎖；金鑰只存在記憶體，鎖定即清除
- 每篇日記有 **標題（title）** 與內容，標題以明文儲存以便側邊欄顯示
- 純 HTML/JS 前端，無框架、無打包步驟
- 自動儲存（停止輸入 0.8 秒後），切換日期前也會先存檔
- 側邊欄列出所有日記，可依日期或標題搜尋
- 日期前後切換、**全螢幕月曆選擇器**（一眼看出哪天寫過、點一下直接跳過去）、「今天」快速鍵
- **從資料夾匯入**：讀取 `YYYY-MM-DD.txt`，先掃描預覽再確認，並列出失敗的檔案
- **收藏**：編輯區的星號按鈕可把日記加入收藏，側邊欄切到「收藏」頁只看收藏的日記
- **唯讀開啟**：已經寫過的日記點開時先進入唯讀，按編輯區右上角的「解鎖編輯」才能修改；空白日期則直接可寫
- **損壞檔保護**：無法解密的日記不會讓清單載入失敗，而是收進側邊欄的「損壞」分類（有壞檔才出現）；點開後編輯器鎖定唯讀，可匯出原始檔或確認後刪除
- **設定頁**：側邊欄的「設定」按鈕開啟，集中管理閒置自動鎖定、變更密碼與 Argon2id 參數
- **閒置自動鎖定**：閒置 1／5／10／15／30／60 分鐘或「永不」後自動鎖定，需重新輸入密碼
- **變更密碼／調整 Argon2id 參數**：只重新包裝 diary key，不重新加密日記，瞬間完成
- **Argon2id 自動校準**：實測本機速度，自動挑出約 1 秒可解鎖的參數
- **繁體中文／英文介面**：右上角一鍵切換，日期格式也跟著語言改變
- **淺色／深色主題**：解鎖畫面右上角的主題鈕三態循環（跟隨系統 → 淺色 → 深色），選擇存在 `localStorage`
- 刪除單日記（有確認提示）
- 使用**本地時區**判定「今天」，不會因 UTC 造成跨日錯亂

## 鍵盤快速鍵

| 快速鍵                 | 功能             |
| ---------------------- | ---------------- |
| `Ctrl/Cmd + S`         | 立即儲存         |
| `Ctrl/Cmd + Z`         | 還原（編輯區內） |
| `Ctrl/Cmd + Shift + Z` | 重做（編輯區內） |
| `Ctrl/Cmd + T`         | 跳到今天         |
| `Ctrl/Cmd + D`         | 加入／取消收藏   |
| `Ctrl/Cmd + L`         | 鎖定日記         |
| `Ctrl/Cmd + +`         | 放大字體         |
| `Ctrl/Cmd + -`         | 縮小字體         |
| `Ctrl/Cmd + 0`         | 重設字體大小     |
| `Alt + ←` / `Alt + →`  | 前一天 / 後一天  |

還原／重做只在標題或內文取得焦點時生效，其他位置交還給瀏覽器預設行為。
Tauri 在 Linux 與 macOS 上會自動掛一個 `Edit` 選單，其 `Undo` 項目會攔下
`Ctrl+Z` 卻不做事；`build_menu` 因此用 `PredefinedMenuItem` 重建該子選單，
讓這些項目真的轉發到 webview 的編輯指令。

## 唯讀開啟

已經有內容的日記，點開時是唯讀的：文字可以選取、複製、捲動，但游標不會進去，
狀態列顯示「唯讀 · 點右上角解鎖編輯」。要修改時按編輯區右上角的「解鎖編輯」，
游標會跳到內文，之後的輸入照常自動儲存。空白日期不套用唯讀，開起來就能直接寫。

這個狀態和「損壞檔鎖定」是兩件事，程式碼裡也分成兩個旗標：

- `lockedDate`：檔案無法解密，內容根本讀不出來，只能匯出或刪除該檔案。
- `readOnlyEntry`：檔案正常，只是還沒要求編輯，按「解鎖編輯」即可。

唯讀時 `saveNow()` 與 `scheduleSave()` 都會直接返回，所以切換日期時的那次
強制存檔也不會把未修改的內容重寫一遍。

## 全螢幕日期選擇器

點編輯區上方的日期膠囊，會展開一個蓋滿整個視窗的月曆（`#calendar`，`role="dialog"`）：

- **整月一覽**：6×7 的格線鋪滿面板，`has-entry` 的日子在數字下方有一顆強調色小點，所以「哪天有寫、哪天沒寫」是一眼可見的圖樣，而不是要逐格細看。
- **點一下即跳轉**：點任一天就關閉月曆並直接切換到該日期（`pickCalendarDate` → `selectDate`），不需要再按確認。
- **月份摘要**：標題下方顯示「2026 年 10 月 · 寫了 12 天」，只計算屬於該月份的日子，格線中前後月的補格不會被算進去。
- **三種離開方式**：右上角關閉鈕、點面板外的背景遮罩、`Esc`；關閉後焦點會還原到日期膠囊。
- **捲動鎖定**：開啟時在 `<body>` 加上 `calendar-open`（`overflow: hidden`），背景不會跟著滾動。
- **鍵盤操作**：方向鍵在格線內移動焦點、`PageUp` / `PageDown` 換月、`Enter` / `Space` 選取。
- **年／月雙層切換**：月份標籤兩側是內層的「上／下個月」箭頭，再外側一對較淡的雙箭頭是「上／下一年」（`stepCalendarYear`，實作上等於 12 次 `shiftMonth`，所以閏年與跨年邊界仍由同一套日期運算處理）。日記橫跨多年時不必連點 12 次。
- 點月份標籤可跳回目前選取日期所屬的月份；`今天` 鈕則直接選取今天。

面板寬度 `min(46rem, 100%)`，`640px` 以下縮小內距與列高，仍維持整月可見。

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

## 設定頁與自動鎖定

側邊欄底部的「設定」按鈕（在「匯入」與「路徑」之間）開啟設定對話框，內含兩個區塊：

**閒置自動鎖定**：下拉選單提供 `1 / 5 / 10 / 15 / 30 / 60` 分鐘與「永不」，選擇立即寫入設定檔並生效。
實作上只有一個全域 `setTimeout`：任何滑鼠移動、點擊、按鍵、滾輪、觸控或視窗重新取得焦點都會重新計時
（以 capture 階段、`passive` 監聽，不干擾既有事件處理）。計時器到點就呼叫與「鎖定」按鈕相同的流程，
因此鎖定前仍會先存檔。解鎖進入 App 時重新起算，鎖定或關閉設定頁時則停止計時。

**密碼與金鑰派生**：顯示目前 vault 的 Argon2id 參數，並可變更密碼或參數。

- 需要輸入**目前密碼**驗證身分；新密碼留空表示「只改參數、密碼不變」。
- 後端以舊密碼解開 wrapped diary key，再用新密碼（與新參數、**新的 salt**）重新包裝同一把 diary key。
  日記檔與索引完全不動，所以操作是瞬間完成的，也不可能弄壞日記。
- 因為 diary key 沒變，目前的工作階段維持解鎖狀態，不需要重新登入。
- 「自動校準」按鈕會實測本機的 Argon2id 速度，把參數調到約 1 秒可解鎖（詳見下方「KDF 校準」）。

## 主題

介面有**淺色**與**深色**兩套配色，由解鎖畫面右上角（語言鈕左側）的主題鈕控制。按鈕是**三態循環**：

- **跟隨系統**（半滿圓圖示）：依 `prefers-color-scheme` 決定，系統切換時即時跟著變
- **淺色**（太陽圖示）：固定淺色，忽略系統設定
- **深色**（月亮圖示）：固定深色，忽略系統設定

選擇存在 `localStorage`（`fly-diary:theme`），下次啟動自動還原；沒有存過偏好時預設「跟隨系統」。

實作上有幾個重點：

- **`data-theme` 屬性而非單純 media query**：`main.js` 把解析後的結果寫到 `<html data-theme="light|dark">`，`styles.css` 用 `:root[data-theme="dark"]` 覆寫整組變數。這樣使用者選的「淺色」才能蓋過系統的深色偏好 —— 單靠 `@media (prefers-color-scheme)` 做不到。
- **顏色全部走變數**：`styles.css` 裡沒有任何硬編碼色值（除了變數定義本身），29 處原本寫死的 `rgba()` / `#fff` 都改成語意變數，例如 `--hover`（「疊在底層上的淡色」）、`--on-accent`（「畫在強調色上的文字」）、`--overlay`（模態遮罩）。語意命名是關鍵：`--hover` 在淺色是 4% 黑、在深色是 6% 白，同一個名字在兩套主題都成立。
- **`color-scheme`**：兩套主題各自宣告 `color-scheme: light` / `dark`，讓 WebView 的原生元件（捲軸、輸入框、`<details>` 箭頭）跟著換色，不會出現深色背景配淺色捲軸。
- **深色主題的強調色調亮**：淺色的 `#4a7c59` 在深色背景上對比只有約 3:1，不足以當內文，因此深色改用 `#74b287`，並把 `--on-accent` 改成深色，讓主要按鈕上的文字仍然清楚。
- **收藏高亮在深色下重新設計**：淺色的螢光黃在深色背景上會過亮、蓋過文字，深色版改成低飽和的暖褐底（`#453a1c`）配亮邊條，仍然一眼可辨但不搶戲。
- **首次繪製前就套用**：`initTheme()` 在 `init()` 中與字級還原並列，早於任何畫面渲染，避免深色使用者看到一瞬間的淺色閃光。

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

| 項目         | 實作                                                                   |
| ------------ | ---------------------------------------------------------------------- |
| 對稱加密     | AES-256-GCM（`aes-gcm` crate，RustCrypto）                             |
| 金鑰派生     | Argon2id（`argon2` crate），參數存於 `vault.xml`，建立時或設定頁可調整 |
| 預設參數     | 19 MiB 記憶體、2 次迭代、平行度 1（OWASP 建議值）                      |
| 參數範圍     | 記憶體 8–1024 MiB、迭代 1–16、平行度 1–16                              |
| Salt         | 每個 vault 一組隨機 16 bytes，存於 `vault.xml`                         |
| IV / Nonce   | 每次寫入產生新的隨機 12 bytes，與密文一同存檔                          |
| 完整性       | GCM 認證標籤（16 bytes）附在密文尾端，竄改會解密失敗                   |
| 密碼驗證     | 以 master key 解開 wrapped diary key 即代表密碼正確（GCM 標籤驗證）    |
| 金鑰生命週期 | 只存在 Rust 端記憶體（`Zeroizing<[u8; 32]>`），鎖定或關閉即歸零        |

> ⚠️ **忘記密碼無法救回**：master key 由密碼派生且不落地，沒有後門或回復機制。
> 提高 Argon2id 參數會讓離線暴力破解更困難，但也會讓每次解鎖變慢。

### KDF 校準

不同機器的 CPU 速度差距可達數倍，同一組 Argon2id 參數在桌機上可能 0.2 秒、在舊筆電上卻要 3 秒。
設定頁的「自動校準」會實際跑一次派生並計時，目標是**約 1 秒**：

1. 從 64 MiB 記憶體、1 次迭代開始測量。先取上限再往下調，慢機器才不會一開始就超支。
2. 若超過 1 秒就把記憶體砍半重測，直到進入預算或碰到 19 MiB 下限（再低就失去防護意義）。
3. 剩下的時間預算換成迭代次數（上限 16），把記憶體省下的時間補回去。
4. 平行度固定為 1，讓同一台機器每次校準的結果一致，也避免核心數不同的機器算出不同成本。

校準跑在 `spawn_blocking` 上，不會卡住 UI；結果會填進「進階」欄位，按「儲存」才真正套用。

### 變更密碼與參數

因為金鑰階層的間接層，改密碼不需要重新加密任何日記：

```text
舊密碼 ──▶ 舊 master key ──▶ 解開 wrapped diary key
                                        │
新密碼 ──▶ 新 master key ──▶ 重新包裝同一把 diary key ──▶ 寫回 vault.xml
```

`storage::rewrap_vault` 會先驗證舊密碼（解不開就回「密碼錯誤」），再以**新的隨機 salt** 派生新 master key。
即使只改參數、密碼不變，salt 也會換新，所以 master key 一定不同。整個過程只改寫 `vault.xml` 一個檔案。

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
`date` 是唯一的明文欄位，而它本來就已經出現在檔名上。

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
diary key 也**不能互換**。

| 版本 | payload 內容                              | AAD                                     |
| ---- | ----------------------------------------- | --------------------------------------- |
| `4`  | `\x01` + 旗標 + `\n` + 標題 + `\n` + 內容 | `日期 \|\| 0x00 \|\| 版本`（日記）／`fly-diary/index`（索引） |
| `3`  | `\x01` + 旗標 + `\n` + 標題 + `\n` + 內容 | 日期（日記）／`fly-diary/index`（索引） |
| `2`  | 標題 + `\n` + 內容（無旗標，視為未收藏）  | 無                                      |
| `1`  | `<title>` 明文、`<content>` 密文          | 無                                      |

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
刪除走的是既有的 `delete_entry`，同時會把該日期從索引移除。

## 設定檔

App 的設定與日記本體分開存放。設定檔只記錄**日記資料夾在哪裡**與**閒置自動鎖定的分鐘數**，
不含密碼或任何金鑰材料：

- Linux：`~/.config/com.flydiary.app/settings.xml`
- macOS：`~/Library/Application Support/com.flydiary.app/settings.xml`
- Windows：`%APPDATA%\com.flydiary.app\settings.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<settings version="2">
  <diary-dir>/home/user/Documents/diary</diary-dir>
  <auto-lock-minutes>10</auto-lock-minutes>
</settings>
```

`auto-lock-minutes` 只接受 `0`（永不）、`1`、`5`、`10`、`15`、`30`、`60`，其他值會被拒絕。
舊版（`version="1"`）設定檔沒有這個元素，讀取時自動套用預設值 10 分鐘，下次寫入即升級為 `version="2"`。

## 日記儲存位置

**第一次啟動**時，解鎖畫面會要求選擇日記資料夾（可手動輸入或按「瀏覽…」開啟原生選擇器），
預設值為平台的 app data 目錄：

- Linux：`~/.local/share/com.flydiary.app/diary/`
- macOS：`~/Library/Application Support/com.flydiary.app/diary/`
- Windows：`%APPDATA%\com.flydiary.app\diary\`

選定後路徑寫入設定檔，之後每次啟動都從設定檔讀取。App 左下角會顯示實際路徑；
按「路徑」按鈕可重新選擇（會先鎖定日記）。整個資料夾可直接備份，但**沒有密碼就無法還原內容**。

### 切換工作區

解鎖畫面上，已設定的資料夾會顯示在密碼欄上方，右側是「切換工作區」按鈕。按下後路徑欄位展開
（預填目前路徑），可手動輸入或按「瀏覽…」選資料夾：

- 選到的資料夾**已有 vault** → 版面立刻切成「輸入密碼」，直接解鎖那個日記本
- 選到的資料夾**是空的** → 版面切成「設定密碼」，在那裡建立新的 vault
- 按「取消」→ 路徑還原成設定檔裡的值，回到原本的解鎖表單

路徑要按下解鎖／建立才會寫入設定檔，所以中途放棄不會讓 App 指向一個打不開的資料夾。
側邊欄的「路徑」按鈕走的是同一條流程：先鎖定，再開啟同一個選擇器。

若選到的新資料夾**已經有 vault**（例如從備份還原、或切換回舊的日記夾），App 會直接跳到解鎖畫面，
要求輸入**那個 vault 的密碼**，而不是顯示「建立新日記」的表單。這樣就不會誤以為要重新設定密碼，
也不會不小心覆蓋既有資料。

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
./test.sh              # 前端 + Rust 測試，並印出兩邊的 coverage
./test.sh --no-cov     # 只跑測試，不量測覆蓋率
```

也可以分開執行：

```bash
npm test               # 前端（node --test）
npm run test:rust      # Rust（cargo test）
npm run coverage       # 前端 + Rust coverage
```

前端測試放在 `tests/`，用 Node 內建的 test runner，不需要額外安裝套件；受測的純函式在
`src/lib/dates.js` 與 `src/lib/stats.js`，`src/i18n.js` 另有字典完整性檢查（兩份字典的
key 必須一致、`index.html` 與 `main.js` 用到的 key 必須存在）。

各對話框模組（`calendar.js`、`import-dialog.js`、`stats-dialog.js`、`settings-dialog.js`、
`lock-screen.js`）都以 `createXxx(deps)` 工廠形式匯出，依賴全部由參數注入，因此可以在
Node 裡直接測試。`tests/helpers/dom.js` 提供一個約 300 行的極簡 DOM stub（`fakeElement`、
`installDom`、`fakeEls`、`fakeT`、`spy`、`fakeInvoke`），不需要 jsdom 之類的額外套件；
遇到 stub 不支援的 selector 會直接丟錯，避免測試默默通過。

Rust 測試分兩層：`src-tauri/src/*.rs` 內的單元測試，以及 `src-tauri/tests/vault_lifecycle.rs`
的整合測試（建立 vault → 寫入 → 上鎖 → 解鎖 → 讀回 → 改密碼）。涵蓋加解密 roundtrip、
錯誤密碼、密文竄改偵測、XML 序列化、日期驗證、索引重建與匯入流程。

Rust coverage 需要 `cargo-llvm-cov`：

```bash
rustup component add llvm-tools-preview
cargo install cargo-llvm-cov --locked
```

### 5. 打包

```bash
npm run build
```

Linux 只產出 `.deb` 與 `.rpm`，**不產出 AppImage**。AppImage 會把 GTK 一起打包，並在 `AppRun` 裡把 `GTK_IM_MODULE_FILE` 指向打包內的 `immodules.cache`；該 cache 不含 `im-ibus.so` / `im-fcitx.so`，導致輸入法在 AppImage 內完全無法切換。`.deb` / `.rpm` 直接使用系統的 GTK 與系統的輸入法模組，沒有這個問題。

## 專案結構

```
fly-diary/
├── src/                    # 前端（純 HTML/JS/CSS）
│   ├── index.html          # 解鎖畫面 + 編輯器（文字以 data-i18n 標記）
│   ├── main.js             # 編輯器、清單、自動儲存、invoke 呼叫
│   ├── dom.js              # DOM 查表（els），無副作用
│   ├── wiring.js           # 所有事件綁定，以 deps 注入回呼（可單獨測試）
│   ├── calendar.js         # 全螢幕日期選擇器（createCalendar）
│   ├── import-dialog.js    # 匯入對話框：掃描、進度、報告（createImportDialog）
│   ├── stats-dialog.js     # 統計對話框：卡片與長條圖（createStatsDialog）
│   ├── settings-dialog.js  # 設定對話框：自動鎖定、KDF、改密碼（createSettingsDialog）
│   ├── lock-screen.js      # 解鎖畫面、vault 偵測、KDF 校準（createLockScreen）
│   ├── i18n.js             # 多語系字典、t()、日期在地化
│   ├── lib/
│   │   ├── dates.js        # 純日期運算（可單獨測試，無 DOM 依賴）
│   │   └── stats.js        # 統計運算（連續天數、月度/星期分佈）
│   └── styles.css
├── tests/                  # 前端測試（node --test）
│   ├── helpers/
│   │   └── dom.js          # 極簡 DOM stub（fakeElement / installDom / fakeInvoke）
│   ├── dates.test.js
│   ├── stats.test.js
│   ├── i18n.test.js
│   ├── wiring.test.js      # 快捷鍵分派、對話框開關、debounce
│   ├── calendar.test.js    # 月曆格線、焦點移動、月份切換、月份摘要、捲動鎖定
│   ├── import-dialog.test.js   # 掃描結果、覆蓋、進度、報告
│   ├── stats-dialog.test.js    # 統計卡片、長條圖比例
│   ├── settings-dialog.test.js # 自動鎖定選項、KDF 單位換算、儲存驗證
│   └── lock-screen.test.js     # 解鎖/建立 vault、路徑切換、上鎖
├── src-tauri/              # Rust 後端
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json
│   ├── icons/
│   ├── tests/
│   │   └── vault_lifecycle.rs  # 整合測試：建立→寫入→上鎖→解鎖→讀回
│   └── src/
│       ├── main.rs         # 進入點
│       ├── lib.rs          # Tauri commands + 解鎖 session 狀態
│       ├── settings.rs     # 設定檔（日記路徑、自動鎖定）讀寫
│       ├── crypto.rs       # 金鑰派生、KDF 校準、AES-256-GCM 加解密
│       ├── xml.rs          # XML 序列化 / 解析
│       └── storage.rs      # vault 與加密日記的檔案儲存層
├── test.sh                 # 一次跑完兩邊測試與 coverage
├── package.json
└── README.md
```

## Tauri Commands

| Command                                   | 說明                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `get_settings()`                          | 讀取設定檔（是否已設定、日記路徑、預設路徑、自動鎖定分鐘數與可選值）         |
| `set_diary_dir(path)`                     | 將日記路徑寫入設定檔（保留既有的自動鎖定設定）                               |
| `set_auto_lock(minutes)`                  | 寫入閒置自動鎖定分鐘數（`0` 表示永不）                                       |
| `pick_diary_dir()`                        | 開啟原生資料夾選擇器，回傳選擇的路徑                                         |
| `vault_exists()`                          | 是否已建立 vault（判斷首次啟動）                                             |
| `get_kdf_defaults()`                      | 回傳 Argon2id 預設值與可調整範圍                                             |
| `get_vault_kdf()`                         | 回傳目前 vault 的 Argon2id 參數（舊格式回 `null`）                           |
| `calibrate_kdf()`                         | 實測本機速度，回傳約 1 秒可解鎖的參數                                        |
| `change_passphrase(current, new, kdf?)`   | 驗證目前密碼後重新包裝 diary key（新密碼留空＝只改參數）                     |
| `create_vault(passphrase, kdf?)`          | 建立 vault 並立即解鎖，可指定 KDF 參數                                       |
| `unlock(passphrase)`                      | 驗證密碼，將金鑰載入記憶體                                                   |
| `lock()`                                  | 清除記憶體中的金鑰                                                           |
| `is_unlocked()`                           | 目前是否已解鎖                                                               |
| `get_entry(date)`                         | 讀取並解密某天的日記，不存在回 `null`                                        |
| `save_entry(date, title, content)`        | 加密後寫入/覆寫某天的日記                                                    |
| `delete_entry(date)`                      | 刪除某天的日記                                                               |
| `list_entries()`                          | 列出所有日記（新到舊，需解鎖才能取得標題）                                   |
| `list_favourites()`                       | 只列出收藏的日記（新到舊）                                                   |
| `set_favourite(date, favourite)`          | 加入／取消收藏，回傳實際儲存的狀態                                           |
| `rebuild_index()`                         | 丟棄 `index.xml` 並重新掃描所有日記重建索引                                  |
| `list_broken_entries()`                   | 列出無法解密的日記檔（日期、大小、失敗原因）                                 |
| `export_broken_entry(date)`               | 開啟存檔對話框，把原始 `.xml` 位元組複製到指定位置                           |
| `pick_import_dir()`                       | 開啟原生資料夾選擇器，回傳匯入來源路徑                                       |
| `scan_import(importDir)`                  | 掃描資料夾並分類為可匯入／已存在／失敗，不寫入                               |
| `run_import(importDir, dates, overwrite)` | 平行匯入指定日期，回傳成功／略過／失敗報告                                   |
| `upgrade_entries()`                       | 把舊格式日記改寫成 `version="4"`，回傳升級／略過／失敗報告（解鎖後自動呼叫） |
| `today()`                                 | 回傳本地時區的今天日期                                                       |
| `diary_path()`                            | 回傳日記資料夾絕對路徑                                                       |
| `set_screenshot_protection(protected)`    | 開關視窗的截圖／錄影保護（Windows、macOS 有效；Linux 為空操作）              |

## 設計重點

- **設定與資料分離**：設定檔（`settings.xml`）只存日記路徑，放在平台 config 目錄；日記本體放在使用者指定的資料夾，兩者可分別備份或搬移。
- **路徑驗證**：`settings::validate_diary_dir` 要求絕對路徑且不得為檔案系統根目錄，避免工作目錄變動導致日記「消失」。
- **日期即主鍵**：`storage::validate_date` 同時驗證格式並阻擋路徑穿越（如 `../../etc/passwd`），檔名由日期推導，天然保證一天一篇。
- **標題也加密**：標題與內容打包成同一段明文再加密，`list_entries` 必須持有金鑰才能解出標題；鎖定時側邊欄會清空，避免殘留任何標題。
- **加密索引**：`index.xml` 以同一把 diary key 加密存放所有 `{日期, 標題, 收藏}`。列出日記時只解密這一個檔案，不必逐一解密上千篇日記；索引缺失或損毀時會自動回退掃描並重建。
- **收藏旗標放在密文裡**：索引只是快取，重建時是從日記檔重新掃出來的，所以收藏狀態若只存在索引就會在重建後消失。旗標因此寫進 payload 開頭（`\x01` + `1`/`0`），索引只是鏡射一份以便快速列出收藏頁；`save_entry` 自動儲存時會保留既有旗標，不會把使用者的收藏洗掉。
- **壞檔不進索引**：`scan_entries` 遇到無法解讀的檔案時，記下原因後跳過，而不是回傳錯誤。索引因此永遠只包含可讀的日記，側邊欄的「全部」與「收藏」都不會混進壞檔；壞檔改由 `list_broken_entries` 單獨列出。這也讓「一篇壞檔」不會拖垮整個資料夾的載入。
- **壞檔掃描只在必要時跑**：索引是一份「健康檔案清單」，壞檔對它而言是隱形的，所以「這天沒寫」與「這天的日記壞了」只能靠走訪目錄分辨——`list_broken_entries` 因此必須讀取、解析並解密**每一個**日記檔，成本隨篇數線性成長。但存檔不可能產生壞檔（檔案是程式自己剛用手中的金鑰寫的），所以 `refreshList({ scanBroken: false })` 讓自動儲存跳過這次掃描；掃描只保留在解鎖後首次載入、開啟「損壞」分頁、以及 `get_entry` 讀取失敗時。這是自動儲存不再「卡一下」的關鍵。
- **壞檔唯讀鎖定**：`selectDate` 在載入前先查壞檔清單，命中就直接鎖定、完全不呼叫 `get_entry`；`saveNow` 與 `scheduleSave` 也都在 `lockedDate` 有值時提早返回。三層防線確保空白編輯器不可能覆蓋掉一個只是暫時解不開的檔案——這是壞檔處理裡唯一會造成永久資料損失的路徑。
- **匯出不重新序列化**：`export_broken_entry` 用 `fs::copy` 複製原始位元組，不經過 XML 解析再輸出。壞檔的價值就在於它「壞掉的部分」，重新序列化會丟掉未知元素與屬性，反而讓人工搶救更困難。
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
- **可調 KDF**：首次建立 vault 時可在「進階選項」調整 Argon2id 的記憶體／迭代／平行度，參數寫入 `vault.xml`，之後解鎖沿用同一組參數；設定頁可隨時再調整。
- **改密碼只重包金鑰**：`rewrap_vault` 用舊密碼解開 diary key、用新密碼與新 salt 重新包裝，只改寫 `vault.xml`。日記與索引完全不碰，所以不會有「改到一半壞掉」的風險，速度也不受日記數量影響。
- **KDF 校準先高後低**：從 64 MiB 開始往下砍記憶體，第一次測量就是上限，慢機器不會先被一組過重的參數卡住；剩餘預算再換成迭代次數。平行度固定 1，讓結果可重現。
- **閒置計時器只有一個**：所有活動事件都只是重設同一個 `setTimeout`，不累積計時器；鎖定與關閉設定頁時一併清除，避免背景殘留。
- **設定頁需要解鎖才能開**：改密碼要驗證目前密碼、讀參數要讀 vault，所以設定頁只在解鎖後可達；鎖定時會自動關閉並清空密碼欄位。
- **金鑰不落地**：金鑰只存在 `Mutex<Session>` 中並以 `Zeroizing` 包裝，`lock()` 或程式結束即抹除。
- **抹除貫穿整條金鑰路徑**：`unlock_vault` / `create_vault` / `rewrap_vault` / `migrate_legacy_vault` 都直接回傳 `Zeroizing<[u8; 32]>`，不再經過裸 `[u8; 32]` 的堆疊副本；`crypto::decrypt` / `decrypt_with_aad` 回傳 `Zeroizing<Vec<u8>>`，所以解出來的明文（包含被包裝的 diary key）在離開作用域時自動歸零。`pack` / `pack_index` 產生的明文緩衝同樣是 `Zeroizing`，`Entry` 實作 `Drop` 抹除 `title` 與 `content`。`run_import` / `upgrade_entries` 從 session 取出的金鑰副本也包在 `Zeroizing` 裡，批次結束即抹除。
- **關閉 core dump**：`main()` 在 Unix 上把 `RLIMIT_CORE` 設為 0。解鎖期間金鑰在記憶體中，若程式崩潰而寫出 core dump，等於把金鑰明文留在磁碟上；關閉 core dump 是最低成本的一道防線。
- **密文綁定日期與版本（AAD）**：日記 payload 以 `日期 || 0x00 || 版本` 作為 AES-GCM 的 associated data，索引則用固定標籤。搬動或複製檔案、或改寫 `<diary version="…">` 想降級成較弱的 AAD 規則，都會讓驗證標籤對不上而解密失敗，不會安靜地顯示錯誤那天的內容；索引與日記密文也無法互換。
- **背景升級不擋 UI**：`upgrade_entries` 是 `async` 命令，實際改寫跑在 `spawn_blocking`，並以 `upgrade-progress` 事件回報 `(done, total)`。`enterApp()` 刻意不 await，所以解鎖後立刻能寫日記，升級在背後慢慢跑完。
- **升級是冪等且原子的**：已升級的檔案直接跳過，中斷後下次解鎖自動續跑；寫入走「暫存檔 + `rename`」，並在寫入前把新密文解回來比對明文、在 `rename` 前比對 mtime，因此既不會留下半截檔案，也不會覆蓋使用者同時存下的編輯。
- **檔案權限收緊**：所有寫入都走 `fsutil::write_private`，Unix 上檔案固定 `0600`、目錄 `0700`，不依賴行程 umask。`OpenOptions::mode` 只在建立檔案時生效，因此寫入後會再 `set_permissions` 一次，把舊版留下的 `0644` 一併收緊；已存在的日記資料夾（例如使用者自己挑的 `0775` 資料夾）也會清掉 group/other 位元。`vault.xml` 內含 salt、KDF 參數與包裝後的金鑰，是離線暴力破解的完整材料，因此最需要這層保護。
- **CSP 不含 `unsafe-inline` script**：`script-src` 只允許 `'self'`，並加上 `object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`。前端沒有任何 inline `<script>`、`on*=` 屬性或 `eval`，所以拿掉 `unsafe-inline` 不影響功能；`style-src` 仍保留 `unsafe-inline`，因為 JS 會直接設定 `element.style`。
- **防止截圖**：視窗以 `contentProtected: true` 建立，Tauri 會轉成 Windows 的 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 與 macOS 的 `NSWindow.setSharingType(.none)`，讓截圖工具與螢幕錄影／分享只看到黑畫面。鎖定畫面同樣受保護；只有開啟「切換工作區」選擇資料夾時，前端才透過 `set_screenshot_protection` 暫時解除，因為那裡只顯示路徑、使用者可能正想分享螢幕，選完或取消後立刻恢復。
- **本地時區**：`today()` 用 `chrono::Local`，前端日期運算也用本地 `Date`，避免 UTC 跨日問題。
- **存檔不佔主執行緒**：`save_entry` 是 `async` 命令。寫入一篇日記包含讀取舊檔（取回收藏旗標）、加密寫入、解密索引、重新加密寫入索引共四次往返，同步命令會把這些全部壓在主執行緒上，而自動儲存每 800 毫秒就可能觸發一次，使用者打字時就會明顯感到頓挫。
- **資料安全**：自動儲存 + 切換日期前強制存檔 + 鎖定前強制存檔。

## 已知限制

- 日期為明文（檔名與 `<date>`），但標題與內容皆已加密。
- 舊版（SHA-256）vault 會在解鎖時自動遷移，遷移期間需要重新加密所有日記，日記量大時會較慢；遷移完成前無法在設定頁變更密碼。
- 格式升級在解鎖後於背景進行，日記量大時會持續數秒到數十秒；期間狀態列會顯示進度，但日記本身已可正常使用。若升級途中關閉程式，下次解鎖會從剩下的舊格式檔案繼續。
- 自動鎖定只在 App 視窗內計時：若把視窗縮到最小或切到別的程式，仍會照常計時並鎖定（這是刻意的）。
- KDF 校準的結果取決於當下機器負載，忙碌時可能選到偏保守的參數；重新校準即可。
- `index.xml` 與日記檔分開寫入，若程式在兩次寫入之間被強制終止，索引可能落後；下次寫入或呼叫 `rebuild_index()` 即可修復。
- 匯入只讀取資料夾第一層的 `.txt`，不遞迴子資料夾；單檔上限 8 MiB，且必須是 UTF-8。
- 平行匯入的加速幅度受磁碟限制：SSD 上通常快 2–4 倍，傳統硬碟或網路磁碟可能幾乎沒有差異（甚至因 seek 而略慢）。
- 匯入時標題固定取自檔名（`YYYY-MM-DD`），檔案內容全部視為日記本文；若想要自訂標題，匯入後再手動修改即可。
- 目前只有繁體中文與英文兩種語言；後端回傳的錯誤訊息（例如 Rust 端的 `Failed to write entry ...`）仍是英文，尚未翻譯。
- 變更日記路徑不會搬移既有檔案，需自行複製；新路徑若已有 vault 則會直接跳到解鎖畫面，沿用該 vault 的密碼。
- 設定檔本身未加密，任何人可讀到日記資料夾位置（但沒有密碼仍無法解密內容）。
- 檔案權限收緊只在 Unix 生效（`0600` / `0700`）。Windows 上沿用 `%APPDATA%` 既有的 per-user ACL，程式本身不額外設定 ACL；若把日記放在共用磁碟或同步資料夾，請自行確認該處的權限設定。
- AAD 綁定只保護「搬檔」與「索引／日記互換」這類攻擊。若攻擊者同時能改寫檔名與檔案內容，仍可把某一天的密文連同檔名一起搬走——AAD 綁的是檔案自稱的日期，不是外部可信的時間來源。
- 記憶體抹除只保證「程式主動抹除」。`release` profile 設了 `panic = "abort"`，panic 時不會執行 `Drop`，因此 `Zeroizing` 的抹除不會發生；不過行程會立刻結束，作業系統會回收該記憶體（core dump 已由 `RLIMIT_CORE = 0` 關閉）。
- 金鑰仍可能被作業系統換出到 swap 或休眠檔。程式未使用 `mlock` / `madvise(MADV_DONTDUMP)`，若需要更強的保證，請在系統層停用 swap 或啟用加密 swap。
- 前端（webview 內的 JS）持有解密後的標題與內容字串，V8 的 GC 不會抹除這些字串。鎖定時前端會清空編輯器，但無法保證舊字串已從記憶體消失；這是架構性限制。
- `String` / `Vec` 擴容時，舊緩衝會被釋放但不會抹除。`pack` 已用 `Vec::with_capacity` 預留大小避免擴容，但 `String::from_utf8_lossy(...).to_string()` 這類轉換仍會產生無法抹除的暫時副本。
- Linux 不提供 AppImage。AppImage 會打包自己的 GTK，並把 `GTK_IM_MODULE_FILE` 指向打包內的 `immodules.cache`，而該 cache 不含 `im-ibus.so` / `im-fcitx.so`，因此輸入法在 AppImage 內無法切換。請改用 `.deb` / `.rpm`，它們使用系統的 GTK 與系統的輸入法模組。
- 防止截圖只在 Windows 與 macOS 生效。`tao` 沒有 Linux 實作，`set_content_protected` 在 Linux 上是空操作，X11／Wayland 下截圖與錄影仍可取得視窗內容；若需要，請改用 Wayland 的 screencast portal 權限控管或 compositor 層的規則。
- 防止截圖擋的是「作業系統的擷取 API」，不是「看到畫面」。手機拍螢幕、虛擬機／hypervisor 層的擷取、外接擷取卡、以及核心層或注入式工具都不受影響；Windows 上 `WDA_EXCLUDEFROMCAPTURE` 也需 Windows 10 2004 以上。
- 防止截圖在「切換工作區」的資料夾選擇期間會暫時關閉（那裡只顯示路徑），選完或取消後恢復；若在意這段空窗，請避免在分享螢幕時切換工作區。
