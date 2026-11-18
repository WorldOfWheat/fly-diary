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
| `get_settings()`                          | 讀取設定檔（是否已設定、日記路徑、預設路徑、自動鎖定與自動儲存延遲及可選值、是否為行動版） |
| `set_diary_dir(path)`                     | 將日記路徑寫入設定檔（保留既有的自動鎖定與自動儲存設定）                     |
| `set_auto_lock(minutes)`                  | 寫入閒置自動鎖定分鐘數（`0` 表示永不）                                       |
| `set_autosave_delay(ms)`                  | 寫入自動儲存延遲毫秒數（只接受 `200/400/800/1500/3000`）                     |
| `pick_diary_dir()`                        | 桌面版開啟原生資料夾選擇器；行動版直接回傳 App 私有資料夾                     |
| `vault_exists()`                          | 是否已建立 vault（判斷首次啟動）                                             |
| `storage_status(path?)`                   | 回傳 `{ format: "sqlcipher"|"legacy"|"empty", hasVault, hasDatabase }`       |
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
| `recover_vault(phrase, newPassphrase, kdf?)` | 用回復短語解開 diary key，以新密碼重新包裝 `vault.xml` 並解鎖；回傳 `{ legacy, databaseError }` |
| `create_vault(passphrase, kdf?)`          | 建立 vault、空 SQLCipher DB 並立即解鎖，可指定 KDF 參數                      |
| `unlock(passphrase)`                      | 驗證密碼，將金鑰載入記憶體；回傳 `{ legacy, databaseError }`                  |
| `migrate_storage()`                       | 把舊 XML 日記遷移成 SQLCipher（需解鎖）；成功後刪除 XML                      |
| `export_backup()`                         | 需解鎖；開啟存檔對話框，匯出加密 `.tar`（DB 快照 + 金鑰包裝檔 + 附件）        |
| `restore_backup()`                        | 需解鎖；選擇 `.tar`，驗證屬於同一個 vault 後替換 DB 與附件，舊資料保留在 `*.local-backup-*` |
| `check_vault_integrity()`                 | 執行 SQLCipher `cipher_integrity_check` 與 SQLite `integrity_check`         |
| `lock()`                                  | 清除記憶體中的金鑰                                                           |
| `is_unlocked()`                           | 目前是否已解鎖                                                               |
| `get_entry(date)`                         | 從 SQLCipher 讀取某天的日記，不存在回 `null`                                 |
| `save_entry(date, title, content)`        | 寫入/覆寫某天的日記                                                          |
| `delete_entry(date)`                      | 刪除某天的日記、attachment rows 與附件資料夾                                  |
| `save_attachment(date, mime, data, width, height)` | 加密並儲存一張圖片（base64），附加在相簿最後                     |
| `list_attachments(date)`                  | 從 DB manifest 依順序列出圖片 metadata（檔案仍為 sidecar）                   |
| `get_attachment(date, id)`                | 解密單張圖片並回傳 base64 與 MIME（v3 用 attachment_key，舊版用 diary key）  |
| `read_dropped_images(paths)`              | 讀取原生拖放提供的檔案路徑，回傳 base64（供前端壓縮後上傳）                 |
| `read_clipboard_image()`                  | 桌面版從系統剪貼簿讀取圖片並轉成 PNG base64；沒有圖片或行動版回 `null`       |
| `delete_attachment(date, id)`             | 刪除一張圖片並更新 DB manifest                                               |
| `reorder_attachments(date, ids)`          | 以新的 id 順序更新 DB position                                                |
| `list_orphan_attachments()`               | 列出沒有對應 `entries` 列的附件資料夾（需解鎖）                               |
| `delete_orphan_attachments(date)`         | 刪除指定的孤兒附件資料夾與其 DB rows                                         |
| `list_entries()`                          | 從 DB 列出所有日記（新到舊，需解鎖）                                         |
| `list_favourites()`                       | 只列出收藏的日記（新到舊）                                                   |
| `set_favourite(date, favourite)`          | 加入／取消收藏，回傳實際儲存的狀態                                           |
| `rebuild_index()`                         | 相容用；DB 本身就是索引，回傳目前日記清單                                    |
| `scan_vault()`                            | 從 DB 讀取日記清單、重建記憶體全文索引；`broken` 固定為空                    |
| `search_entries(query, limit?, favouritesOnly?)` | 搜尋日期、標題與內容，回傳命中摘要與 UTF-16 標記範圍（需解鎖）      |
| `list_broken_entries()`                   | 列出遷移時保留在加密 `legacy_broken` 表的無法解讀 XML                        |
| `export_broken_entry(date)`               | 有 `legacy_broken` 時匯出原始 XML bytes；否則以 `VACUUM INTO` 匯出 DB 快照   |
| `pick_import_dir()`                       | 桌面版開啟原生資料夾選擇器；行動版回報不支援資料夾匯入                       |
| `scan_import(importDir)`                  | 掃描資料夾並分類為可匯入／已存在／失敗，不寫入                               |
| `run_import(importDir, dates, overwrite)` | 以單一 DB transaction 匯入指定日期，回傳成功／略過／失敗報告                 |
| `upgrade_entries()`                       | 相容用 no-op；舊格式升級已包含在 `migrate_storage`                           |
| `today()`                                 | 回傳本地時區的今天日期                                                       |
| `diary_path()`                            | 回傳日記資料夾絕對路徑                                                       |
| `set_screenshot_protection(protected)`    | 開關視窗的截圖／錄影保護（Windows、macOS 有效；Linux 為空操作）              |

> 行動版（`#[cfg(mobile)]`）的差異：`get_settings` 的 `mobile: true` 會讓解鎖畫面隱藏
> 「瀏覽…」與「切換工作區」，設定頁也隱藏變更路徑按鈕；`pick_diary_dir` 仍直接回傳
> App 私有資料夾、`pick_import_dir` 回報不支援 `.txt` 資料夾匯入、選單列不建置。
> 加密備份 `.tar` 的還原在桌面與 Android 都可用，檔案位置由系統選擇器決定；
> 一般備份建議直接複製整個日記資料夾。
