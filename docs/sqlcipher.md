# SQLCipher 儲存層

[← 回到文件索引](README.md)

自 SQLCipher 版本起，日記的**唯一主要儲存**是 `diary.db`，以 SQLCipher 加密。
`vault.xml` 與 `recovery.xml` 的角色完全不變：它們仍然只負責包裝 diary key。
**其他 XML 格式已完全廢除**；附件 manifest 存在 DB，不再有 `YYYY-MM-DD.xml`、
`index.xml`、`manifest.xml` 或每日 `.fd` 檔。

## 檔案佈局

```text
diary/
├── vault.xml                     # 不變：Argon2id 包裝 diary key
├── recovery.xml                  # 不變：BIP39 短語包裝同一把 diary key
├── diary.db                      # 唯一儲存：SQLCipher
├── diary.db-wal / diary.db-shm   # 執行期間的 WAL，關閉後消失
└── attachments/
    └── YYYY-MM-DD/
        └── <id>.bin              # 圖片 sidecar（加密）
```

資料庫是權威來源，沒有每日衍生檔。舊 XML 只在一次性遷移時讀取，成功後刪除。
備份是使用者明確匯出的 `.tar`（資料庫快照 + 金鑰包裝檔 + 附件），不是背景同步。

## 金鑰階層

```text
密碼 ──Argon2id──▶ master key ──AES-256-GCM unwrap──▶ diary key (32B)
回復短語 ──BIP39 + SHA-256──▶ recovery key ──AES-256-GCM unwrap──▶ diary key

diary key ──HKDF-SHA256("fly-diary/sqlcipher/v1")──▶ db_key
diary key ──HKDF-SHA256("fly-diary/attachment/v3")──▶ attachment_key
```

- `vault.xml` / `recovery.xml` 不保存任何子金鑰，只保存被包裝的 diary key。
- 新增附件使用 `attachment_key`；舊版 v1／v2 附件仍用 diary key，讀取時由檔案
  header 的版本決定，因此不需要批次重新加密既有圖片。
- 換密碼只重包裝 `vault.xml`，DB 與附件金鑰不變。
- 未來若要輪換 diary key，必須同時 `PRAGMA rekey` 資料庫、重新加密附件、
  重包 `vault.xml` 與 `recovery.xml`；目前沒有提供這個操作。

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

CREATE TABLE legacy_broken (
  date   TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  size   INTEGER NOT NULL,
  data   BLOB NOT NULL
);
```

`meta` 保存 `schema_version`、`format=sqlcipher`、`vault_id`、`key_id`。開啟時會比對
`vault_id`／`key_id`；把 DB 從別的 vault 複製過來會直接拒絕。

`attachments` 沒有 foreign key，因為「有附件資料夾但沒有日記」的孤兒狀態是既有功能，
設定頁需要能列出並清理它；刪除日記時由 `delete_entry` 明確刪除 attachment rows。
`legacy_broken` 保存遷移時無法解密／解析的 XML 原始位元組，讓舊的「損壞」分頁仍可
列出與匯出，同時不必把 XML 留在資料夾裡。

## 加密備份 `.tar`

備份是使用者從設定頁匯出的單一檔案，內容是未壓縮的 tar：

```text
diary.db                     # VACUUM INTO 的一致快照（仍是 SQLCipher 密文）
vault.xml                    # 包裝後的 diary key
recovery.xml                 # 選用；有啟用回復短語時才存在
attachments/YYYY-MM-DD/*.bin # 每張圖片的加密 sidecar
```

- `VACUUM INTO` 在單一 read transaction 內產生一致的資料庫副本，不需要停止 App，
  輸出是單一檔案（沒有 `-wal`／`-shm`）。
- 輸出沿用連線的 SQLCipher key，因此備份檔仍是密文；備份不含額外密碼，安全邊界
  仍是原本的密碼／回復短語。
- 附件是 sidecar，必須一起備份；DB 的 `attachments` 表只存順序與 MIME。
- 還原時會先解壓到暫存目錄，用目前的 diary key 執行 `verify_snapshot` 與
  `cipher_integrity_check`，確認 `vault_id`／`key_id` 與目前 vault 相符後，才把
  `diary.db` 與 `attachments/` 換入；舊資料留在 `<diary>.local-backup-*`。
- `vault.xml` 與 `recovery.xml` 在備份檔內供手動救援，但 App 內還原**不會覆寫**
  目前的金鑰包裝檔，避免把密碼或回復短語回滾到舊狀態。
- 備份不是同步：沒有三方比較、沒有衝突合併，也不會自動上傳。

## 舊 XML 的處置（破壞性變更）

開啟資料夾時：

- 有 `diary.db` → 目前格式，直接解鎖。
- 只有 `vault.xml`（沒有 `diary.db`）→ 舊 XML 格式。鎖定畫面會顯示提示；
  解鎖成功後詢問是否遷移。若其實是損壞或誤刪的 DB，請改用加密備份還原。
- 只有 `.fd` 而沒有 `diary.db` → 拒絕遷移並提示先用 1.0.0 重建／匯出；新版不再讀取 `.fd`。
- 使用者拒絕 → 呼叫 `lock`，顯示「請更換其他 workspace 或新建」，不會進入編輯器。

遷移流程（`migrate_storage`）：

1. 驗證解鎖後的 diary key 能讀取 `index.xml` 或至少一篇 XML；錯誤金鑰不會建立空 DB。
2. 在 `diary.db.migrating` 建立 schema。
3. 逐一讀取 `YYYY-MM-DD.xml`，解密後寫入 DB；無法解讀的檔案把原始位元組寫進
   `legacy_broken`，不留在磁碟上。
4. 從 `attachments/*/manifest.xml` 匯入附件順序與 MIME；manifest 缺失時改掃 sidecar。
5. `PRAGMA quick_check` 通過後，fsync 暫存檔再原子 rename 成 `diary.db`。
6. 刪除 `YYYY-MM-DD.xml`、`index.xml` 與所有 `manifest.xml`。成功後資料夾的 XML
   只剩 `vault.xml` 與 `recovery.xml`。

遷移可重試：中斷只會留下 `diary.db.migrating`，下次會刪掉重建；在 rename 之前
XML 仍是唯一真相。若某個 XML 連原始位元組都無法讀取，它不會被刪除，並會出現在
遷移警告中；這是唯一可能留下的例外。

## 完整性、救援與備份

- **逐篇壞檔隔離消失**：SQLCipher 是 page-level 加密 + HMAC，單一壞頁可能讓整個
  DB 無法開啟。`check_vault_integrity` 會跑 `cipher_integrity_check` 與
  `integrity_check`。
- **DB 無法開啟時**：`unlock` 回報 `databaseError` 後，解鎖畫面會出現「還原加密備份」；
  重新輸入密碼後會直接開啟備份檔並還原。解鎖後也可從設定頁執行。App 不會自動建立空 DB，
  避免覆蓋唯一副本。
- **刪除後的殘留**：`DELETE` 只把 page 放回 free list。`secure_delete=ON` 會先把
  內容歸零再加密，但仍建議刪除後執行 `PRAGMA wal_checkpoint(TRUNCATE)`，並定期
  `VACUUM`／`incremental_vacuum`。`VACUUM INTO` 備份只寫 live pages，不含 free list。
- **備份**：設定頁的「匯出備份」會產生自包含的 `.tar`。完整的手動備份等價於
  `diary.db`（一致的 `VACUUM INTO` 快照）+ `vault.xml` + `recovery.xml` +
  `attachments/`。只複製執行中的 `diary.db` 不是一致快照，請先鎖定並 checkpoint，
  或使用內建匯出。
- **降級**：舊版 App 只認識 XML，SQLCipher 版本不再產生 XML。升級後請不要降級；
  舊版會看到空日記，或把新內容寫成 XML，造成分岔。

## 建置

`src-tauri/Cargo.toml`：

```toml
rusqlite = { version = "0.32", features = ["bundled-sqlcipher-vendored-openssl"] }
hkdf = "0.12"
```

`bundled-sqlcipher-vendored-openssl` 會編譯 SQLCipher 與 OpenSSL，Linux／macOS／
Windows 可重現，但建置時間與 binary 大小會增加。Android 交叉編譯需要 NDK 的
`CC_*`／`AR_*`／`RANLIB_*` 與 perl；請在 `pnpm android:dev` 先驗證一次。
