# 無障礙（WCAG 2.2 AA）

[← 回到 README](../README.md) · [文件索引](README.md)

Fly Diary 的目標是 **WCAG 2.2 AA**，不是 AAA。WCAG 的合規聲明必須針對「頁面／狀態」逐一驗證，而這個 App 有多個狀態（解鎖、列表、編輯器、月曆、匯入、統計、設定、損壞檔、淺色／深色、中／英文、桌面／手機）。以下區分「已實作」與「仍需手動驗證或補做」。

## 已實作

- **鍵盤操作**
  - 側邊列表的每一列都是真正的 `<button>`，可用 Tab 聚焦、Enter／Space 開啟；目前日期有 `aria-current="date"`。
  - 月曆維持方向鍵、`PageUp`／`PageDown`、`Home`／`End` 與 `Esc`。
  - 圖片排序除了拖放，也有箭頭按鈕的替代操作。
- **表單標籤**
  - 密碼、確認密碼、搜尋、標題、內容都有關聯的 `<label>`；視覺設計不變的老鼠／觸控使用者不會看到額外文字。
  - KDF、設定頁欄位沿用既有的 `<label for>`。
- **焦點**
  - `textarea`、`select`、`a` 與 `#content` 都有 `:focus-visible`；`#content` 的焦點環畫在內側，不會被編輯區裁掉。
  - 月曆、設定、匯入、統計、回復短語與獨立確認視窗都使用共用的 focus trap：Tab／Shift+Tab 在對話框內循環，關閉後焦點回到開啟前的元素（月曆保留原本的 `dateLabel` 還原規則）。
  - BIP39 單字磁磚是 `role="combobox"` + `role="listbox"`：方向鍵移動建議、Enter 選取或前往下一個字、Escape 關閉建議；每個輸入都有「第 N 個字」標籤。
- **錯誤與狀態**
  - `#lock-error`、`#import-error`、`#settings-error` 都是 `role="alert"`。
  - 儲存狀態、圖片狀態、匯入進度使用 `role="status"`／`aria-live`／`role="progressbar"`。
- **對比與可讀性**
  - 淺色 `--text-muted` 改為 `#6f6c66`，對 `--bg`／`--panel` 達 4.5:1。
  - 新增 `--border-strong`（淺色 `#8a8780`、深色 `#76726b`），表單控制項與 icon-only 按鈕的邊界達 3:1。
  - placeholder 不再使用 0.5／0.6 的透明度，並套用同一個 muted token。
- **Target size（2.5.8）**
  - `.attachment-control`、`.modal-close` 提升到 1.75rem；語言切換、返回、鎖定、瀏覽等小按鈕加上最小高度。觸控裝置另維持 44px 級距。
- **圖表與圖片**
  - 統計長條圖的每個 bar 都有 `role="img"` 與「月份：篇數」的 `aria-label`。
  - 圖片檢視器沿用 `attachments.viewerAlt` 作為 `alt`。
- **其他**
  - `prefers-reduced-motion` 會關閉轉場與動畫。
  - 側邊篩選改成 `aria-pressed` 的 toggle buttons，不再假裝是 tablist。

## 仍需處理或驗證

- **200% 文字縮放**：目前使用者倍率上限是 1.6，400px 以下壓到 1.2；尚未證明 200% 時所有功能仍可用。這是下一個最大的 AA 缺口。
- **螢幕閱讀器實測**：尚未用 NVDA、VoiceOver、TalkBack 走過完整流程。虛擬滾動只保留可見列，需確認螢幕閱讀器的清單導覽與重新渲染行為。
- **後端錯誤訊息語言**：部分 Rust 錯誤仍是英文，在中文介面中會混用語言（WCAG 3.1.2 Language of Parts）。
- **Skip link／一致的說明入口**：目前靠 landmarks（`aside`／`main`）提供跳轉；可再加「跳到編輯區」的 skip link 與一致的說明位置。
- **自動化瀏覽器稽核**：目前只有靜態測試（標籤、對比 token、target size、focus trap）與手動 checklist；尚未接 axe-core／Playwright。自動工具只能抓一部分問題，不能取代螢幕閱讀器測試。

## 手動驗證清單

每次改到 UI 時至少跑：

1. **只用鍵盤**：Tab 走完解鎖 → 列表 → 編輯器 → 月曆 → 設定 → 匯入 → 統計；每個動作都能用 Enter／Space／方向鍵完成，焦點不被遮住。
2. **螢幕閱讀器**：NVDA（Windows）、VoiceOver（macOS）、TalkBack（Android）各開一次，確認表單標籤、錯誤朗讀、列表按鈕、對話框標題與焦點還原。
3. **縮放**：200% 文字、400% 瀏覽器縮放（或 320px reflow）；文字不重疊、不被截斷，主要功能仍可用。
4. **主題與語言**：淺色／深色 × 中文／英文，檢查 muted、border、focus ring 與 placeholder。
5. **手機**：觸控 target、螢幕閱讀器、實體鍵盤（若有）、橫向／直向、status bar 與手勢列。

## 測試

```bash
pnpm test
```

相關測試：

- `tests/a11y.test.js`：表單標籤、live region、toggle 語意、muted／border 對比、placeholder、target size。
- `tests/focus-trap.test.js`：Tab／Shift+Tab 循環、從對話框外進入、關閉後焦點還原。
- `tests/styles.test.js`：`hidden` 疊層、z-index、手機版顯隱。

> 這些測試是回歸護欄，不是 WCAG 合規證明。合規仍需要上述手動驗證與完整的狀態矩陣。
