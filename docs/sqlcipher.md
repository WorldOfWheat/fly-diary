# SQLCipher 儲存層

[← 回到文件索引](README.md)

自 SQLCipher 版本起，日記的**唯一主要儲存**是 `diary.db`，以 SQLCipher 加密。
`vault.xml` 與 `recovery.xml` 的角色完全不變：它們仍然只負責包裝 diary key。
**其他 XML 格式已完全廢除**；每日同步使用新的加密二進位 `.fd` 檔，附件 manifest
存在 DB，不再有 `YYYY-MM-DD.xml`、`index.xml` 或 `manifest.xml`。

## 檔案佈局

```text
diary/
├── vault.xml                     # 不變：Argon2id 包裝 diary key
├── recovery.xml                  # 不變：BIP39 短語包裝同一把 diary key
├── diary.db                      # 主要儲存：SQLCipher
├── diary.db-wal / diary.db-shm   # 執行期間的 WAL，關閉後消失
├── YYYY-MM-DD.fd                 # 每日加密同步檔（二進位，不是 XML）
└── attachments/
    └── YYYY-MM-DD/
        └── <id>.bin              # 圖片 sidecar（加密）
```

資料庫是權威來源。`.fd` 是每日同步單位：存檔時先寫 DB，再從 DB 產生當天的
`.fd`；同步拉回 `.fd` 後匯入 DB。舊 XML 只在一次性遷移時讀取，成功後刪除。

## 金鑰階層

```text
密碼 ──Argon2id──▶ master key ──AES-256-GCM unwrap──▶ diary key (32B)
回復短語 ──BIP39 + SHA-256──▶ recovery key ──AES-256-GCM unwrap──▶ diary key

diary key ──HKDF-SHA256("fly-diary/sqlcipher/v1")──▶ db_key
diary key ──HKDF-SHA256("fly-diary/attachment/v3")──▶ attachment_key
diary key ──HKDF-SHA256("fly-diary/sync/v1")──────▶ sync_key
```

- `vault.xml` / `recovery.xml` 不保存任何子金鑰，只保存被包裝的 diary key。
- 新增附件使用 `attachment_key`；舊版 v1／v2 附件仍用 diary key，讀取時由檔案
  header 的版本決定，因此不需要批次重新加密既有圖片。
- `.fd` 同步檔使用 `sync_key`，與 DB、附件金鑰分離。
- 換密碼只重包裝 `vault.xml`，DB、附件與 `.fd` 金鑰不變。
- 未來若要輪換 diary key，必須同時 `PRAGMA rekey` 資料庫、重新加密附件與 `.fd`、
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

## 每日同步檔 `.fd`

`.fd` 是二進位格式，不是 XML，也不使用 SQLCipher：

```text
magic "FDDAY" (5) | version (1) | date "YYYY-MM-DD" (10) | IV (12) | ciphertext+tag
```

明文 payload（加密前）包含：

- 標題、內容、收藏旗標
- 附件 metadata：id、MIME、寬、高、順序

AAD 綁定 `vault-id`、`key-id`、日期與版本。把 `.fd` 改名到另一天、跨 vault 搬移或
改版本都會解密失敗。

同步規則不變：

1. DB commit 後寫當天的 `.fd`；內容沒變且檔案存在時不重寫。
2. 同步前 `ensure_sync_records` 補齊缺失或比 `updated_at` 舊的 `.fd`。
3. 同步拉回 `.fd` 後，`import_sync_paths` 在單一 transaction 內匯入 entry 與附件
   metadata。
4. 本機刪除日記時 DB 與 `.fd` 一起移除；同步引擎看到本機檔案消失，會刪除遠端
   同一天的檔案（既有規則不變）。
5. 衝突解析選擇 `remote` 時，拉回的 `.fd` 會重新匯入 DB。
6. 附件圖片是 sidecar，不在 `.fd` 裡；`.fd` 只帶 metadata，圖片仍可單張延遲解密。

`sync.rs` 仍以一天一個檔案做三向比較；只是檔案從 XML 變成 `.fd`。

## 舊 XML 的處置（破壞性變更）

開啟資料夾時：

- 有 `diary.db` → 目前格式，直接解鎖。
- 沒有 `diary.db` 但有 `.fd` → `needsRebuild`：還原同步資料夾後的情境。解鎖後直接
  詢問是否從 `.fd` 重建，不會走 XML 遷移（`migrate_storage` 也會拒絕，避免建立空 DB
  後刪掉唯一的 `.fd`）。
- 只有 `vault.xml`、沒有 `diary.db` 或 `.fd` → 舊 XML 格式。鎖定畫面會顯示提示；
  解鎖成功後詢問是否遷移。

若同一個資料夾同時有 `.fd` 與未遷移的 XML，系統會優先視為 `needsRebuild`，因為 `.fd`
是較新的同步來源。要改從 XML 遷移時，先把 `.fd` 移到別處。
- 使用者拒絕 → 呼叫 `lock`，顯示「請更換其他 workspace 或新建」，不會進入編輯器。

遷移流程（`migrate_storage`）：

1. 驗證解鎖後的 diary key 能讀取 `index.xml` 或至少一篇 XML；錯誤金鑰不會建立空 DB。
2. 在 `diary.db.migrating` 建立 schema。
3. 逐一讀取 `YYYY-MM-DD.xml`，解密後寫入 DB；無法解讀的檔案把原始位元組寫進
   `legacy_broken`，不留在磁碟上。
4. 從 `attachments/*/manifest.xml` 匯入附件順序與 MIME；manifest 缺失時改掃 sidecar。
5. `PRAGMA quick_check` 通過後，fsync 暫存檔再原子 rename 成 `diary.db`。
6. 從 DB 寫出所有 `.fd`。
7. 刪除 `YYYY-MM-DD.xml`、`index.xml` 與所有 `manifest.xml`。成功後資料夾的 XML
   只剩 `vault.xml` 與 `recovery.xml`。

遷移可重試：中斷只會留下 `diary.db.migrating`，下次會刪掉重建；在 rename 之前
XML 仍是唯一真相。若某個 XML 連原始位元組都無法讀取，它不會被刪除，並會出現在
遷移警告中；這是唯一可能留下的例外。

同步時也會清理舊格式：遠端 `index.xml` 與 `manifest.xml` 一律刪除；
`YYYY-MM-DD.xml` 只有在同一天已有 `.fd` 時才刪除，避免讓尚未遷移的裝置失去唯一副本。

## 完整性、救援與備份

- **逐篇壞檔隔離消失**：SQLCipher 是 page-level 加密 + HMAC，單一壞頁可能讓整個
  DB 無法開啟。`check_vault_integrity` 會跑 `cipher_integrity_check` 與
  `integrity_check`。
- **DB 無法開啟時的救援**：`unlock` 回報 `databaseError` 後，前端可呼叫
  `rebuild_storage`。它會把舊 DB 移到 `diary.db.corrupt-*`，再從每日 `.fd` 重建
  entries 與附件 metadata。圖片 sidecar 不動。若某些 `.fd` 也損壞，會列在報告中且
  不會被刪除。
- **刪除後的殘留**：`DELETE` 只把 page 放回 free list。`secure_delete=ON` 會先把
  內容歸零再加密，但仍建議刪除後執行 `PRAGMA wal_checkpoint(TRUNCATE)`，並定期
  `VACUUM`／`incremental_vacuum`。備份檔也可能含有已刪除的舊 page。
- **備份**：完整備份是 `diary.db` + `vault.xml` + `recovery.xml` + `attachments/`。
  只複製 `diary.db` 打不開，因為 DB key 來自 `vault.xml` 裡包裝的 diary key。
  執行中的 DB 不要直接複製；使用 `VACUUM INTO`（`export_broken_entry` 在沒有
  遷移壞檔時會匯出一致的加密快照）或先 checkpoint + close。
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
