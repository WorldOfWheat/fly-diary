# SQLCipher 儲存層

[← 回到文件索引](README.md)

自 SQLCipher 版本起，日記的**主要儲存**是 `diary.db`，以 SQLCipher 加密。
`vault.xml` 與 `recovery.xml` 的角色完全不變：它們仍然只負責包裝 diary key。
`YYYY-MM-DD.xml` 與 `attachments/*/manifest.xml` 則降級為**同步鏡像**，供 Android
資料夾同步與舊版相容使用。

## 檔案佈局

```text
diary/
├── vault.xml                     # 不變：Argon2id 包裝 diary key
├── recovery.xml                  # 不變：BIP39 短語包裝同一把 diary key
├── diary.db                      # 主要儲存：SQLCipher
├── diary.db-wal / diary.db-shm   # 執行期間的 WAL，關閉後消失
├── YYYY-MM-DD.xml                # 每日同步鏡像（舊 XML 格式）
├── index.xml                     # 已廢除；只可能在舊資料夾看到
└── attachments/
    └── YYYY-MM-DD/
        ├── manifest.xml          # 同步鏡像；主要 manifest 在 DB
        └── <id>.bin              # 圖片 sidecar（加密）
```

資料庫是權威來源。XML 鏡像由資料庫產生；同步拉回檔案後，新的
`sync_now` / `bind_sync_dir` 會把拉回的 `YYYY-MM-DD.xml` 與 `manifest.xml`
匯入資料庫。舊版 App 仍可讀到 XML 鏡像，但**不支援降級**：舊版看不到 DB 裡的
新變更，也不應該和 SQLCipher 版本同時寫同一個資料夾。

## 金鑰階層

```text
密碼 ──Argon2id──▶ master key ──AES-256-GCM unwrap──▶ diary key (32B)
回復短語 ──BIP39 + SHA-256──▶ recovery key ──AES-256-GCM unwrap──▶ diary key

diary key ──HKDF-SHA256("fly-diary/sqlcipher/v1")──▶ db_key
diary key ──HKDF-SHA256("fly-diary/attachment/v3")──▶ attachment_key
```

- `vault.xml` / `recovery.xml` 不保存 `db_key` 或 `attachment_key`，只保存被包裝的
  diary key。
- 新增附件使用 `attachment_key`；舊版 v1／v2 附件仍用 diary key，讀取時由檔案
  header 的版本決定，因此**不需要批次重新加密既有圖片**。
- 換密碼只重包裝 `vault.xml`，DB 與附件金鑰不變。
- 未來若要輪換 diary key，必須同時 `PRAGMA rekey` 資料庫、重新加密附件、重包
  `vault.xml` 與 `recovery.xml`；目前沒有提供這個操作。

## SQLCipher 開啟方式

diary key 已經是 32 bytes 隨機值，所以使用 SQLCipher 的 **raw key** 形式，避免再跑
一次 PBKDF2：

```rust
PRAGMA cipher_memory_security = ON;
PRAGMA cipher_page_size = 4096;
PRAGMA cipher_hmac_algorithm = HMAC_SHA512;
PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512;
PRAGMA key = "x'<64 hex of db_key>'";
SELECT count(*) FROM sqlite_master;   -- 真正驗證 key
```

- `PRAGMA key` 是第一個帶資料的語句；上面的 cipher 設定必須在它之前。
- `PRAGMA key = ?` 不支援 bound parameter，key 會出現在 SQL 字串中。實作以
  `Zeroizing<String>` 包住 hex 與 SQL 字串，套用後立刻抹除，且不寫 log。
- 開啟後設定 `WAL`、`synchronous=FULL`、`foreign_keys=ON`、`secure_delete=ON`、
  `busy_timeout=5000`。
- `PRAGMA key` 失敗會得到 `SQLITE_NOTADB`；App 把它轉成「目前 diary key 無法開啟
  此資料庫」。
- `PRAGMA cipher_integrity_check` 驗證每一頁的 HMAC；`PRAGMA integrity_check`
  另外驗證邏輯一致性。兩者由 `check_vault_integrity` command 執行。

## Schema

```sql
PRAGMA user_version = 1;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE entries (
  date       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  favourite  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX entries_favourite_date ON entries(favourite, date DESC);

CREATE TABLE attachments (
  date     TEXT NOT NULL,
  id       TEXT NOT NULL,
  mime     TEXT NOT NULL,
  width    INTEGER NOT NULL DEFAULT 0,
  height   INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  PRIMARY KEY (date, id)
) WITHOUT ROWID;

CREATE INDEX attachments_date_position ON attachments(date, position);

CREATE TABLE attachment_manifests (
  date       TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

`attachments` 沒有 foreign key，因為「有附件資料夾但沒有日記」的孤兒狀態是既有功能，
設定頁需要能列出並清理它；刪除日記時由 `delete_entry` 明確刪除 attachment rows。
`attachment_manifests.updated_at` 讓同步前的 `export_mirror_manifests` 只重寫缺失或
過期的 manifest，不會每次同步都換一個新 IV、造成無意義的上傳。

`meta` 保存 `schema_version`、`format=sqlcipher`、`vault_id`、`key_id`。開啟時會比對
`vault_id`／`key_id`；把 DB 從別的 vault 複製過來會直接拒絕，即使金鑰剛好相同。

## 每日同步鏡像

`sync.rs` 的三向比較與 SAF 外掛沒有改變，仍然以「一天一個檔案」為單位。差別是：

1. 儲存時先寫 DB（commit），再從 DB 產生當天的 `YYYY-MM-DD.xml` 鏡像。
2. 同步前 `ensure_entry_mirrors` 會補齊缺失或比 `updated_at` 舊的鏡像。
3. 同步拉回 `report.pulled` 裡的檔案後，`import_replica_paths` 會把
   `YYYY-MM-DD.xml` 與 `attachments/<date>/manifest.xml` 匯入 DB。
4. 本機刪除日記時，DB 與鏡像都會移除；同步引擎看到本機檔案消失，會刪除遠端
   同一天的檔案（既有規則不變）。
5. 衝突解析選擇 `remote` 時，拉回的檔案會重新匯入 DB。

附件圖片不進 DB：manifest（順序、MIME、尺寸）在 DB，`<id>.bin` 留在 sidecar。
這樣 DB 不會因為幾百張 5 MiB 圖片而膨脹，圖片仍可單張延遲解密；同步也維持一天
一個 manifest 的單位。

## 舊格式遷移

開啟資料夾時：

- 有 `diary.db` → 目前格式，直接解鎖。
- 只有 `vault.xml`、沒有 `diary.db` → 舊 XML 格式。鎖定畫面會顯示提示；解鎖成功
  後詢問是否遷移。
- 使用者拒絕 → 呼叫 `lock`，顯示「請更換其他 workspace 或新建」，不會進入編輯器。

遷移流程（`migrate_storage`）：

1. 驗證解鎖後的 diary key 能讀取 `index.xml` 或至少一篇 XML；錯誤金鑰不會建立空 DB。
2. 在 `diary.db.migrating` 建立 schema。
3. 逐一讀取 `YYYY-MM-DD.xml`，解密後寫入 DB；損壞的檔案跳過並列入報告，原檔保留。
4. 從 `attachments/*/manifest.xml` 匯入附件順序與 MIME；manifest 缺失時改掃 sidecar。
5. `PRAGMA quick_check` 通過後，原子 rename 成 `diary.db`。
6. XML 與附件原檔留在原位，成為同步鏡像。

遷移可重試：中斷只會留下 `diary.db.migrating`，下次會刪掉重建；在 rename 之前
XML 仍是唯一真相。若 `vault.xml` 被刪除但 `diary.db` 還在，建立新 vault 時會移除
孤兒 DB（新 diary key 本來就解不開它）。

## 完整性、刪除與備份

- **逐篇壞檔隔離消失**：SQLCipher 是 page-level 加密 + HMAC，單一壞頁可能讓整個
  DB 無法開啟；不再有「列出壞掉的第 N 篇並原樣匯出」的概念。請改用
  `check_vault_integrity`。若 `unlock` 回報 `databaseError`，前端會詢問是否用
  `rebuild_storage` 從每日 XML 鏡像重建；舊 DB 會保留為 `diary.db.corrupt-*`，
  不會直接刪除。
- **刪除後的殘留**：`DELETE` 只把 page 放回 free list。`secure_delete=ON` 會先把
  內容歸零再加密，但仍建議刪除後執行 `PRAGMA wal_checkpoint(TRUNCATE)`，並定期
  `VACUUM`／`incremental_vacuum`。備份檔也可能含有已刪除的舊 page。
- **備份**：完整備份是 `diary.db` + `vault.xml` + `recovery.xml` + `attachments/`。
  只複製 `diary.db` 打不開，因為 DB key 來自 `vault.xml` 裡包裝的 diary key。
  執行中的 DB 不要直接複製；使用 `VACUUM INTO`（`export_broken_entry` 現在就是
  匯出一致的加密快照）或先 checkpoint + close。
- **降級**：舊版 App 只讀 XML 鏡像，看不到 DB 的新變更；混合版本寫同一個資料夾
  會分岔。升級後請不要降級，也不要讓舊版與新版同時同步。

## 建置

`src-tauri/Cargo.toml`：

```toml
rusqlite = { version = "0.32", features = ["bundled-sqlcipher-vendored-openssl"] }
hkdf = "0.12"
```

`bundled-sqlcipher-vendored-openssl` 會編譯 SQLCipher 與 OpenSSL，Linux／macOS／
Windows 可重現，但建置時間與 binary 大小會增加。Android 交叉編譯需要 NDK 的
`CC_*`／`AR_*`／`RANLIB_*` 與 perl；請在 `pnpm android:dev` 先驗證一次。
