# CSS Reset

reset 檔位於 [`src/styles/reset.css`](../src/styles/reset.css)，由入口
[`src/styles.css`](../src/styles.css) 以第一個 `@import` 載入，順序早於
`tokens.css`、`base.css` 與所有元件樣式。

## 設計原則

- **只處理瀏覽器預設**：盒模型、`body` 外距、圖片底線空隙、表單控制項外距與字體繼承。
- **不做 universal reset**：沒有 `* { margin: 0; padding: 0 }`。標題、段落、清單、表單與按鈕的
  語意預設會保留；需要調整間距的元件在自己的 stylesheet 明確設定。
- **零特異度**：表單規則使用 `:where()`，任何 class 規則都能自然覆寫，不需要 `!important`。
- **保留原生外觀**：不移除按鈕與輸入框的 border、padding、background 或 `appearance`。

## 載入順序

```css
/* src/styles.css */
@import url("./styles/reset.css");   /* 瀏覽器預設 */
@import url("./styles/tokens.css");  /* 色彩與字體變數 */
@import url("./styles/base.css");    /* app primitive 與 scoped 間距 */
/* ...其他元件樣式 */
```

`@import` 的順序就是 cascade 順序。reset 必須最先載入，元件樣式才能覆寫它。

## 規則與目的

| # | 選擇器 | 目的 | 刻意不做的事 |
| --- | --- | --- | --- |
| 1 | `*, *::before, *::after` | 統一 `box-sizing: border-box`，讓寬高包含 padding 與 border，包含偽元素 | 不移除任何 margin／padding |
| 2 | `html` | `-webkit-text-size-adjust: 100%`／`text-size-adjust: 100%`，避免手機橫向時瀏覽器放大文字 | 不改 `font-size`；流體字級仍由 `base.css` 控制 |
| 3 | `body` | 移除瀏覽器預設的 8px 外距，讓 app shell 貼齊視窗 | 只移除 `body` 的外距，不動其他元素 |
| 4 | `img, picture, video, canvas` | `display: block` 移除行內圖片的基線空隙；`max-width: 100%` 防止溢出 | 不處理 `svg`，避免破壞行內圖示的基線對齊 |
| 5 | `img, video` | `height: auto` 在只限制寬度時維持原始長寬比 | 不限制高度或裁切圖片 |
| 6 | `:where(button, input, select, textarea)` | 表單控制項繼承頁面字體、顏色與字距；`margin: 0` 統一 checkbox／radio 等控制項的外距 | 不移除 border、padding、background 或原生 `appearance` |
| 7 | `textarea` | `resize: vertical`，避免使用者把輸入框拖成橫向破壞欄位 | 不強制高度；需要固定高度的地方自行設 `resize: none` |
| 8 | `table` | `border-collapse: collapse`、`border-spacing: 0`，讓表格邊界可預期 | 不移除 cell padding、border 或對齊 |
| 9 | `[hidden]` | 確保 `hidden` 屬性一定勝過元件的 `display`，避免透明浮層留在畫面上攔截點擊 | 不用來做一般排版間距 |

## 保留的瀏覽器預設

- 標題（`h1`–`h6`）與段落（`p`）的上下外距。
- `ul`／`ol` 的項目符號與縮排。
- 按鈕、輸入框、`select`、`fieldset` 的原生邊框與內距。
- `:focus`／`:focus-visible` 焦點指示。
- 原生日期選擇器與 checkbox／radio 外觀。

## 與 `base.css` 的分工

`reset.css` 只管瀏覽器預設；`base.css` 放 app 自己的 primitive。例如：

- `button { padding: 0 }`：app 自己畫按鈕外觀，內距由 `.btn-primary`、`.btn-browse` 等 class 提供。
- `.lock-title`、`.settings-hint` 等文案 class 設 `margin: 0`：這些區塊用 flex／grid `gap`
  排版，不應該再疊加瀏覽器預設外距。
- `.sidebar-header h1 { margin: 0 }`：sidebar 標題是 flex row 的一員。
- 觸控行為、`overscroll-behavior` 與焦點樣式也留在 `base.css`，因為它們是 app 行為，不是瀏覽器預設。

## 如何覆寫

- 直接用 class 或更高等級的選擇器即可；reset 的表單規則特異度為 0。
- 不要新增 `* { margin: 0; padding: 0 }`。若某個區塊需要歸零，把 `margin: 0` 寫在該 class 上。
- 版面用 flex／grid 的 `gap` 控制間距，避免依賴相鄰元素的 margin collapse。
- 需要顯示被 `hidden` 隱藏的元素時，移除 `hidden` 屬性，不要用 `display: ... !important` 對抗。
  需要依狀態顯示的浮層，使用 `:not([hidden])` 撰寫版面規則。

## 驗證

```bash
node --test tests/*.test.js
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

手動檢查以下畫面，確認沒有因瀏覽器預設外距而位移：解鎖／建立 vault、設定、
匯入、統計、回復短語、月曆、圖片 lightbox，以及手機版兩層式排版。
