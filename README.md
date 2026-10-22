# Fly Diary

一個用 Tauri 2 寫的極簡日記 App：**一天只會有一篇**，以 Markdown 檔案儲存。

## 功能

- 一天一篇：檔名即日期（`YYYY-MM-DD.md`），同一天再存只會覆寫，不會產生重複
- 純 HTML/JS 前端，無框架、無打包步驟
- 自動儲存（停止輸入 0.8 秒後），切換日期前也會先存檔
- 側邊欄列出所有日記，可依日期或內容搜尋
- 日期前後切換、日期選擇器、「今天」快速鍵
- 刪除單日記（有確認提示）
- 使用**本地時區**判定「今天」，不會因 UTC 造成跨日錯亂

## 鍵盤快速鍵

| 快速鍵 | 功能 |
|---|---|
| `Ctrl/Cmd + S` | 立即儲存 |
| `Ctrl/Cmd + T` | 跳到今天 |
| `Alt + ←` / `Alt + →` | 前一天 / 後一天 |

## 日記儲存位置

日記存在平台的 app data 目錄下：

- Linux：`~/.local/share/com.flydiary.app/diary/`
- macOS：`~/Library/Application Support/com.flydiary.app/diary/`
- Windows：`%APPDATA%\com.flydiary.app\diary\`

App 左下角會顯示實際路徑。每個檔案就是一篇 Markdown，可直接用外部編輯器開啟或備份。

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

### 4. 打包

```bash
npm run build
```

## 專案結構

```
fly-diary/
├── src/                    # 前端（純 HTML/JS/CSS）
│   ├── index.html
│   ├── main.js             # UI 邏輯、自動儲存、invoke 呼叫
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
│       ├── lib.rs          # Tauri commands
│       └── storage.rs      # 檔案儲存層（含單元邏輯）
├── package.json
└── README.md
```

## Tauri Commands

| Command | 說明 |
|---|---|
| `get_entry(date)` | 讀取某天的日記，不存在回 `null` |
| `save_entry(date, content)` | 寫入/覆寫某天的日記 |
| `delete_entry(date)` | 刪除某天的日記 |
| `list_entries()` | 列出所有日記（新到舊，含預覽） |
| `today()` | 回傳本地時區的今天日期 |
| `diary_path()` | 回傳日記資料夾絕對路徑 |

## 設計重點

- **日期即主鍵**：`storage::validate_date` 同時驗證格式並阻擋路徑穿越（如 `../../etc/passwd`），檔名由日期推導，天然保證一天一篇。
- **本地時區**：`today()` 用 `chrono::Local`，前端日期運算也用本地 `Date`，避免 UTC 跨日問題。
- **資料安全**：自動儲存 + 切換日期前強制存檔 + 關閉視窗前嘗試存檔。
