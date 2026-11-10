# 參考資料

[← 回到 README](../README.md) · [文件索引](README.md)

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

## Tauri Commands

| Command                                   | 說明                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `get_settings()`                          | 讀取設定檔（是否已設定、日記路徑、預設路徑、自動鎖定與自動儲存延遲及可選值） |
| `set_diary_dir(path)`                     | 將日記路徑寫入設定檔（保留既有的自動鎖定與自動儲存設定）                     |
| `set_auto_lock(minutes)`                  | 寫入閒置自動鎖定分鐘數（`0` 表示永不）                                       |
| `set_autosave_delay(ms)`                  | 寫入自動儲存延遲毫秒數（只接受 `200/400/800/1500/3000`）                     |
| `pick_diary_dir()`                        | 桌面版開啟原生資料夾選擇器；行動版直接回傳 App 私有資料夾                     |
| `vault_exists()`                          | 是否已建立 vault（判斷首次啟動）                                             |
| `recovery_exists(path?)`                  | 指定日記資料夾是否設有 `recovery.xml`（解鎖畫面用來決定是否顯示短語入口）   |
| `get_kdf_defaults()`                      | 回傳 Argon2id 預設值與可調整範圍                                             |
| `get_vault_kdf()`                         | 回傳目前 vault 的 Argon2id 參數（舊格式回 `null`）                           |
| `calibrate_kdf()`                         | 實測本機速度，回傳約 1 秒可解鎖的參數                                        |
| `change_passphrase(current, new, kdf?)`   | 驗證目前密碼後重新包裝 diary key（新密碼留空＝只改參數）                     |
| `generate_recovery_phrase()`              | 產生 12 個 BIP39 單字與 3 個確認位置；不寫入任何檔案                          |
| `get_bip39_words()`                       | 回傳官方 BIP39 英文 wordlist（供輸入前綴建議）                              |
| `confirm_recovery_phrase(phrase, indices, answers)` | 驗證 checksum 與指定單字後寫入 `recovery.xml`（需解鎖）       |
| `get_recovery_status()`                   | 回傳 `{ enabled }`                                                          |
| `remove_recovery()`                       | 刪除 `recovery.xml`（需解鎖）                                                |
| `recover_vault(phrase, newPassphrase, kdf?)` | 用回復短語解開 diary key，以新密碼重新包裝 `vault.xml` 並解鎖             |
| `create_vault(passphrase, kdf?)`          | 建立 vault 並立即解鎖，可指定 KDF 參數                                       |
| `unlock(passphrase)`                      | 驗證密碼，將金鑰載入記憶體                                                   |
| `lock()`                                  | 清除記憶體中的金鑰                                                           |
| `is_unlocked()`                           | 目前是否已解鎖                                                               |
| `get_entry(date)`                         | 讀取並解密某天的日記，不存在回 `null`                                        |
| `save_entry(date, title, content)`        | 加密後寫入/覆寫某天的日記                                                    |
| `delete_entry(date)`                      | 刪除某天的日記與附件資料夾                                                   |
| `save_attachment(date, mime, data, width, height)` | 加密並儲存一張圖片（base64），附加在相簿最後                     |
| `list_attachments(date)`                  | 依 manifest 順序列出圖片 metadata                                           |
| `get_attachment(date, id)`                | 解密單張圖片並回傳 base64 與 MIME                                           |
| `read_dropped_images(paths)`              | 讀取原生拖放提供的檔案路徑，回傳 base64（供前端壓縮後上傳）                 |
| `read_clipboard_image()`                  | 桌面版從系統剪貼簿讀取圖片並轉成 PNG base64；沒有圖片或行動版回 `null`       |
| `delete_attachment(date, id)`             | 刪除一張圖片並更新 manifest                                                 |
| `reorder_attachments(date, ids)`          | 以新的 id 順序重寫 manifest                                                 |
| `list_orphan_attachments()`               | 列出沒有對應日記的附件資料夾                                                |
| `delete_orphan_attachments(date)`         | 刪除指定的孤兒附件資料夾                                                    |
| `list_entries()`                          | 列出所有日記（新到舊，需解鎖才能取得標題）                                   |
| `list_favourites()`                       | 只列出收藏的日記（新到舊）                                                   |
| `set_favourite(date, favourite)`          | 加入／取消收藏，回傳實際儲存的狀態                                           |
| `rebuild_index()`                         | 丟棄 `index.xml` 並重新掃描所有日記重建索引                                  |
| `list_broken_entries()`                   | 列出無法解密的日記檔（日期、大小、失敗原因）                                 |
| `export_broken_entry(date)`               | 開啟存檔對話框，把原始 `.xml` 位元組複製到指定位置                           |
| `pick_import_dir()`                       | 桌面版開啟原生資料夾選擇器；行動版回報不支援資料夾匯入                       |
| `scan_import(importDir)`                  | 掃描資料夾並分類為可匯入／已存在／失敗，不寫入                               |
| `run_import(importDir, dates, overwrite)` | 平行匯入指定日期，回傳成功／略過／失敗報告                                   |
| `upgrade_entries()`                       | 把舊格式日記改寫成 `version="4"`，回傳升級／略過／失敗報告（解鎖後自動呼叫） |
| `today()`                                 | 回傳本地時區的今天日期                                                       |
| `diary_path()`                            | 回傳日記資料夾絕對路徑                                                       |
| `set_screenshot_protection(protected)`    | 開關視窗的截圖／錄影保護（Windows、macOS 有效；Linux 為空操作）              |

> 行動版（`#[cfg(mobile)]`）的差異只有三處：`pick_diary_dir` 直接回傳 App 私有資料夾、
> `pick_import_dir` 回報不支援資料夾匯入、選單列不建置。其餘命令桌面與行動版共用同一份實作。
