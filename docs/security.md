# 安全設計

[← 回到 README](../README.md) · [文件索引](README.md)

Fly Diary 的威脅模型是「日記檔案被取得，但攻擊者沒有密碼或回復短語」。主要儲存是 SQLCipher 的 `diary.db`；備份是使用者明確匯出的加密 `.tar`（資料庫快照 + 金鑰包裝檔 + 附件）。以下說明金鑰階層、KDF、AAD、回復短語、記憶體保護、供應鏈防護與已知限制。

> **XML 已完全廢除**：除了 `vault.xml` 與 `recovery.xml`，App 不再讀寫任何日記 XML。
> 舊格式只在一次性遷移時讀取，成功後刪除；無法解讀的原始位元組存進加密的
> `legacy_broken` 表。新格式與救援流程見 [sqlcipher.md](sqlcipher.md)。

## 加密設計

### 金鑰階層

```text
密碼 ──Argon2id(salt, 參數)──▶ master key（32 bytes，永不落地）
                                  │
                                  │ AES-256-GCM
                                  ▼
                    wrapped diary key（存於 vault.xml）
                                  │
回復短語 ──BIP39 解碼──▶ entropy ──SHA-256(domain)──▶ recovery key
                                  │
                                  │ AES-256-GCM
                                  ▼
              recovery-wrapped diary key（存於 recovery.xml）
                                  │
                                  │ AES-256-GCM
                                  ▼
                              日記檔案
```

- **master key**：由密碼經 Argon2id 派生，只用來包裝 diary key，不直接加密日記。
- **diary key**：隨機 32 bytes，真正用來加密日記。它被 master key 包裝後存進 `vault.xml`。
- **recovery key**（可選）：12 個 BIP39 英文單字編碼 128-bit 隨機值，經 domain-separated SHA-256 展成 32 bytes，用來包裝同一把 diary key。它存在 `recovery.xml`，不影響 `vault.xml`。
- 這層間接讓「改密碼」、「升級 KDF 參數」或「重新產生回復短語」都只需要重新包裝 32 bytes，不必重新加密所有日記。

| 項目          | 實作                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 對稱加密      | AES-256-GCM（`aes-gcm` crate，RustCrypto）                                                                                             |
| 金鑰派生      | Argon2id（`argon2` crate），參數存於 `vault.xml`，建立時或設定頁可調整                                                                 |
| 預設參數      | 64 MiB 記憶體、3 次迭代、平行度 1（高於 OWASP 建議值）                                                                                 |
| 參數範圍      | 記憶體 64–1024 MiB、迭代 2–16、平行度 1–16                                                                                             |
| 新密碼長度    | 至少 12 個字元；由 Rust 後端強制，不只靠前端                                                                                           |
| Salt          | 每個 vault 一組隨機 16 bytes，存於 `vault.xml`                                                                                         |
| IV / Nonce    | 每次寫入產生新的隨機 12 bytes，與密文一同存檔                                                                                          |
| 完整性        | GCM 認證標籤（16 bytes）附在密文尾端，竄改會解密失敗；SQLCipher 另以每頁 HMAC-SHA512 認證                                              |
| 資料庫        | `diary.db` 以 SQLCipher raw key 加密；DB key 由 diary key 經 HKDF-SHA256 派生                                                          |
| 圖片附件      | v3 使用 HKDF 派生的 `attachment_key`，每張獨立 IV；舊 v1／v2 仍用 diary key                                                            |
| 附件 manifest | 存在 SQLCipher 的 `attachments` 表，沒有 XML 檔案                                                                                      |
| 備份檔        | `.tar` 內是 `VACUUM INTO` 的 SQLCipher 密文快照 + `vault.xml`／`recovery.xml` + 附件密文                                               |
| 密碼驗證      | 以 master key 解開 wrapped diary key 即代表密碼正確（GCM 標籤驗證）                                                                    |
| 回復短語      | BIP39 12 字（128-bit）→ SHA-256 展成 32 bytes，AAD 綁固定 domain label 與版本                                                          |
| 金鑰生命週期  | 存在 Rust 端的鎖定頁（`LockedKey`），mlock 進 RAM、Linux／Android 排除 dump/fork、Windows 排除 WER dump；鎖定或關閉即抹除、解鎖、unmap |

> ⚠️ **忘記密碼無法救回**（除非已啟用回復短語）：master key 由密碼派生且不落地，沒有後門。
> 提高 Argon2id 參數會讓離線暴力破解更困難，但也會讓每次解鎖變慢。

### Vault 身分與 AAD

`vault.xml` v3 會記錄兩組隨機 16 bytes 的公開識別碼：

- `vault-id`：這個日記本的身分；建立或首次解鎖舊 vault 時產生。
- `key-id`：目前 diary key 的身分；未來輪換 diary key 時會更新。

SQLCipher 以每頁 HMAC-SHA512 認證整個資料庫，`db_key` 由 diary key 經 HKDF 派生。
備份檔是資料庫的 `VACUUM INTO` 快照，沿用同一把 key，沒有新的加密格式或 AAD；
它與一般 `diary.db` 一樣，離開 `vault.xml` 就無法解開。

舊 XML 格式（只在遷移時讀取）與 `vault.xml`／`recovery.xml` 仍使用下列 canonical、
長度前綴的 AAD：

```text
"fly-diary/aad/v5" || kind || vault-id || key-id
  || len(field1) || field1 || len(field2) || field2 ...
```

欄位包含 object kind（legacy entry/manifest/attachment/recovery/vault-wrap）、日期、
附件 id、格式版本；wrapped diary key 另外綁定 salt 與 KDF 參數。這樣把密文搬到別的
日期、把不同 object 互換、或把整組密文搬到另一個 vault，都會在 GCM 驗證時失敗。
**不要**把 app 版本、檔案路徑、mtime 或裝置 id 放進 AAD，否則升級或同步後會解不開。

舊的 v4 entry、v4 index、v1 manifest/attachment 與 v1 recovery 仍可讀取；新寫入不再
產生 entry/index/manifest XML。舊 `recovery.xml` 因缺少短語無法自動重包裝，會維持
v1，直到下次成功復原或重新產生短語。AAD 只能證明上下文，不能防 replay／rollback；
能改寫整個資料夾的攻擊者仍可把舊檔搬回來。

### KDF 校準

不同機器的 CPU 速度差距可達數倍，同一組 Argon2id 參數在桌機上可能 0.2 秒、在舊筆電上卻要 3 秒。
設定頁的「自動校準」會實際跑一次派生並計時，目標是**約 1 秒**：

1. 從 128 MiB 記憶體、1 次迭代開始測量。先取上限再往下調，慢機器才不會一開始就超支。
2. 若超過 1 秒就把記憶體砍半重測，直到進入預算或碰到 64 MiB 下限（再低就低於目前的離線防護目標）。
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

### 回復短語（可選）

回復短語是**第二把獨立的鑰匙**，不是第二組密碼：

- 程式產生 128-bit 隨機值，編碼成 12 個 BIP39 英文單字。使用者不能自訂短語，否則熵會降到可猜測。
- 128-bit 已經遠超離線暴力破解可行範圍，因此**不需要 Argon2id**；只做 domain-separated SHA-256 展成 AES-256 key。有效強度仍是短語的 128 bits。
- 它包裝的是同一把 diary key，所以啟用、重新產生或停用短語都**不會重新加密任何日記**；改密碼或改 KDF 參數也不會讓短語失效。
- 復原流程只做兩件事：用短語解開 diary key，再用**新密碼**與新 salt 重新包裝 `vault.xml`。日記、索引與附件完全不動。
- 解出 diary key 後，會先用 `index.xml`（或第一篇可解密的日記）實際驗證它屬於這個 vault，才允許覆寫 `vault.xml`。這擋掉「把別的日記本的 `recovery.xml` 複製過來」時用錯誤金鑰蓋掉正確 wrapped key 的情況；驗證失敗時 vault 保持原樣。

短語包裝存在 `recovery.xml`，而不是 `vault.xml`。這是刻意的：舊版 App 在改密碼或改 KDF 參數時，會用固定欄位重建 `vault.xml`，不認識的 recovery 欄位會被靜默刪掉。獨立檔案對舊版而言不存在，所以不會被覆寫；而 diary key 在改密碼時不變，短語也就持續有效。

`recovery.xml` v2 的 AAD 綁定 `vault-id`、`key-id`、object kind 與版本；v1 仍保留舊的 `"fly-diary/recovery" || 0x00 || version`，因為沒有回復短語就無法重新包裝舊檔。把 recovery blob 換到另一個 vault 時，v2 會直接解密失敗；v1 仍會由 `diary_key_matches` 驗證並保持 vault 不變。下次成功復原或重新產生短語時會寫成 v2。

**顯示與確認**：

- 短語只在產生時顯示一次，之後無法再次查看。
- 顯示畫面用 `user-select: none`，並攔截 `copy` / `cut` / `contextmenu` / `dragstart` / `selectstart`，且沒有複製或列印按鈕。這是**UI 層面的抄寫引導，不是安全邊界**：webview 仍可被檢視，真正的要求是使用者把短語寫在紙上。
- 按下「我已抄寫，繼續」後，短語會從畫面移除，並開啟獨立的確認視窗；使用者必須重新輸入三個隨機位置的單字。輸入框提供 BIP39 前綴建議（例如 `ap` 列出 `apple` 等），但後端仍會再驗證一次 BIP39 checksum 與這三個答案，通過後才寫入 `recovery.xml`。取消或中途關閉不會留下任何檔案。

**風險**：短語等於完整的讀取權。取得短語與日記資料夾的人不需要密碼、也沒有速率限制就能解密全部內容。短語必須與日記分開保存；不要截圖、不要放進同一個同步資料夾或雲端相簿。備份日記資料夾時要一併複製 `recovery.xml`，否則短語無法使用；刪除 `recovery.xml` 等於停用短語。

### 記憶體保護

解鎖期間 diary key 必須留在記憶體，因此 `Session` 不直接持有裸陣列，而是 `secure_memory::LockedKey`：

- **專用一頁**：用 `mmap`（Unix）或 `VirtualAlloc`（Windows）配置一頁，key 放在頁首，避免鎖到旁邊不相干的 heap 物件。
- **不進 swap**：`mlock`（Unix）／`VirtualLock`（Windows）把這一頁鎖在 RAM。
- **不進 dump、不進 fork**：Linux 與 Android 加 `madvise(MADV_DONTDUMP)` 與 `MADV_WIPEONFORK`，core dump 與 fork 出的子行程都不會帶走金鑰。
- **Windows 不進 WER dump**：key page 會註冊到 `WerRegisterExcludedMemoryBlock`，Drop 時解除；`VirtualLock` 本身不阻止 crash dump。
- **同使用者也讀不到**：Linux／Android 啟動時 `prctl(PR_SET_DUMPABLE, 0)`，關掉 `/proc/<pid>/mem` 與同使用者 `ptrace` attach；Unix 另保留 `RLIMIT_CORE = 0`。代價是 gdb／profiler 不能直接 attach，開發時若要除錯需暫時註解這行。
- **一定會抹除**：`Drop` 先 zeroize 整段 key，再 `munlock`／`VirtualUnlock`，最後 `munmap`／`VirtualFree`。
- **可失敗**：`mlock` 可能因 `RLIMIT_MEMLOCK`、sandbox 或平台限制而失敗；這時仍照常解鎖，只是少了「不進 swap」那層保證，不會把 App 卡住。
- **suspend／resume**：前端監聽 Tauri 的 `tauri://suspended` / `tauri://resumed`、`visibilitychange` 與 `pagehide`，在背景化或休眠前走同一條「先存檔再鎖定」路徑；Android 另外由 `FLAG_SECURE` 阻止截圖與最近任務縮圖。HTML 檔案選擇器與 Android SAF 檔案選擇器也會讓 webview 短暫背景化，因此前端有一層 native-picker guard：選擇器開啟期間、以及關閉後 2 秒內不觸發 suspend lock；guard 最多維持 2 分鐘，避免選擇器沒有回報關閉時長期停用背景鎖定。

這層保護只涵蓋**長時間存活的 session key**。`session_key()` 複製給背景工作的暫時副本、AES key schedule，以及 webview 裡的明文仍是架構性暴露，詳見「已知限制」。

全文搜尋索引是額外的明文暴露面：它保存解鎖期間所有日記的標題與內容（原文與小寫副本），供關鍵字比對。索引只存在 Rust 記憶體、**不落盤**，`lock()` 會直接丟棄整個索引並 zeroize 每個字串；但它不在 `LockedKey` 的鎖定頁內，也不阻止休眠。搜尋結果只把命中摘要（而非整篇內容）送到 webview。

### Android 備份與畫面保護

Android 的 `vault.xml`、`recovery.xml`、日記與附件必須能備份，否則換手機就失去日記，因此沒有關閉 Auto Backup。作法是「有條件、可驗證的備份」：

- `android:allowBackup="true"`，以 `dataExtractionRules`（Android 12+）與 `fullBackupContent`（Android 11 以前）只包含日記資料、排除 cache。
- `cloud-backup` 加上 `disableIfNoEncryptionCapabilities="true"`：裝置沒有可用的備份加密能力時就不上傳。
- `recovery.xml` 會一起備份，但回復短語本身不在備份裡；取得備份仍需要密碼或短語才能解開 wrapped key。
- `MainActivity` 設定 `FLAG_SECURE`，避免截圖、螢幕錄影與最近任務縮圖看到明文。
- 備份與螢幕保護由 `scripts/harden-android.mjs` 套用；`src-tauri/gen/android` 仍保持 gitignored，重新產生 Android 專案後要用 `pnpm android:init`／`android:dev`／`android:build` 重新套用。

### 加密備份與還原

設定頁的「匯出備份」會產生一個未壓縮的 `.tar`，內含 `VACUUM INTO` 的加密資料庫快照、
`vault.xml`、選用的 `recovery.xml`，以及 `attachments/` 下所有密文 sidecar。
若 `diary.db` 無法開啟，解鎖畫面在密碼驗證成功後會直接提供「還原加密備份」按鈕；
使用者需再輸入一次密碼（金鑰不留在鎖定畫面），驗證後才換檔。

- **只寫密文**：快照沿用 SQLCipher key，附件維持原本的 `attachment_key` 加密；備份
  過程不需要把明文寫到磁碟，也不會上傳到任何服務。
- **一致性**：`VACUUM INTO` 在單一 read transaction 內完成，輸出是沒有 WAL 的單一
  檔案；附件在設定頁 modal 開啟期間複製，使用者無法同時編輯。
- **還原前驗證**：備份先解到 App cache 的暫存目錄，以目前 diary key 開啟快照並比對
  `vault_id`／`key_id`，再跑 `cipher_integrity_check`；任一項失敗都不會動到現有 DB。
- **保留舊資料**：還原只替換 `diary.db` 與 `attachments/`，舊資料移到
  `<diary>.local-backup-<timestamp>`。`vault.xml` 與 `recovery.xml` 不覆寫，避免把
  密碼或回復短語回滾。
- **備份檔的風險**：`.tar` 內含包裝後的 diary key，和 `vault.xml` 一樣是離線暴力
  破解的材料；必須與日記分開保存。取得備份檔的人仍需要密碼或回復短語才能解開 DB。
- **不是同步**：沒有三方比較或衝突合併；兩台裝置各自還原會回到各自備份當時的狀態。
- **Auto Backup 的範圍**：Android Auto Backup 只涵蓋 App 私有資料，不包含使用者自行
  匯出到其他位置的 `.tar`。異地副本要由使用者自己的備份工具負責。

### 檔案系統防護

- 暫存檔使用 `create_new` + `O_NOFOLLOW` + 隨機 suffix；避免在共用／同步資料夾中被預放 symlink，讓寫入轉向其他檔案。
- `vault.xml`、`recovery.xml` 與 settings 都有硬讀取上限；備份解壓時也限制單檔大小、檔案數與合法路徑，超大的損壞檔會被拒絕，不會讓 App OOM。
- 路徑中的 `..` 與 symlink 會被拒絕；Windows 共用磁碟／FAT 的 ACL 仍要由使用者確認。
- 需要解鎖才能使用的命令（拖放圖片、剪貼簿、自動鎖定設定、匯出壞檔等）都要求 session；截圖保護的暫時關閉移到 Rust 的原生資料夾選擇器內。

## 供應鏈安全

這個 repo 的依賴很少，但仍把供應鏈防護寫進 CI，避免「上游被盜帳號、tag 被移動、
或 build 時執行惡意 script」直接變成發佈內容：

- **鎖檔與完整性**：`pnpm-lock.yaml`（含 integrity）與 `src-tauri/Cargo.lock`（含 checksum）
  都進版控；CI、release 與 `test.sh` 一律使用 `--frozen-lockfile` / `--locked`，
  lockfile 與 manifest 不一致時直接失敗，不會偷偷改成別的版本。
- **不執行依賴 install script**：`.npmrc` 設定 `ignore-scripts=true`；目前依賴不需要
  lifecycle script，新增套件若需要就必須在 PR 中明確處理。
- **精確版本**：`package.json` 的 Tauri 套件改為精確版本；npm 端沒有其他 transitive 依賴。
- **Actions 固定到 commit SHA**：所有 `uses:` 都 pin 到完整 SHA，並由 Dependabot 更新；
  可變 tag（例如 `@v4`、`@v0`）不再出現在 workflow 裡。
- **最小權限**：workflow 預設 `contents: read`，只有 release 的 `publish` job 有
  `contents: write`；checkout 一律 `persist-credentials: false`。
- **Release 從乾淨的 target 目錄建置**：release 不 restore `Swatinem/rust-cache`，
  避免 PR 可寫的 build cache 影響發佈產物。
- **自動審計**：`.github/workflows/security.yml` 在 PR 與每週排程跑 `cargo audit`
  與 `pnpm audit`；release 也把同一個 workflow 當成發佈前的 gate，審計沒過就不會 publish。
  Dependabot 每週檢查 npm、Cargo 與 GitHub Actions。
- **建置來源證明**：release 產物會用 `actions/attest-build-provenance` 產生
  provenance，使用者可用 `gh attestation verify <file>` 驗證。
- **手動設定（GitHub repo settings，程式無法代勞）**：為 `v*` 開啟 tag protection、
  為 `release` environment 設 required reviewers，並限制誰能 push tag。
  若之後啟用 Tauri updater，簽章私鑰應放在 `release` environment 的 secrets，
  不放在一般 repo secrets。

> 這些措施能阻擋 tag 被移動、lockfile 被替換、安裝期 script 與已知漏洞，
> 但無法防止「某個已鎖定版本的原始碼本身就是惡意」；新增依賴仍應人工 review，
> 必要時可再加 `cargo vet` / `cargo deny`。

## 已知限制

- 日期只會出現在附件資料夾名稱 `attachments/YYYY-MM-DD/`；標題、內容與附件 metadata 皆已加密。
- 舊版（SHA-256）vault 會在解鎖時自動遷移；v2 vault 會補上 `vault-id`／`key-id`。這些步驟仍需要重新加密 XML，完成前無法在設定頁變更密碼。遷移會先寫下 `migration.journal`（內含新 vault 的 salt 與包裝後的新 diary key）才開始改寫日記，所以中途斷電不會讓日記卡在「一半用舊金鑰、一半用新金鑰」；下次解鎖會偵測到 journal 並自動續跑。
- 升級到 SQLCipher 後，舊 XML 的格式升級不再於解鎖後背景進行；`migrate_storage` 會一次讀取 v1–v4 並寫入 DB。這一步需要解鎖，且會先建立 `diary.db.migrating`，通過 `quick_check` 後才 rename；成功後刪除 XML。中斷只會留下可刪除的暫存 DB。無法解讀的 XML 原始位元組會存進加密的 `legacy_broken`，不會留在磁碟上。
- 閒置計時只在 App 視窗內計算；另外會在 Tauri 的 suspend／resume、`visibilitychange`、`pagehide` 與 Android 背景化時鎖定。若平台沒有送出 suspend 事件，切到其他視窗時 WebView 可能節流計時器，這時要等回到 App 後由 wall-clock deadline 立刻鎖定；休眠瞬間仍可能有極短空窗。
- KDF 校準的結果取決於當下機器負載，忙碌時可能選到偏保守的參數；重新校準即可。
- SQLCipher 的 `INSERT`／`UPDATE`／附件 manifest 更新都在單一 transaction 內完成；DB 是唯一權威來源，沒有需要追平的衍生檔。
- 原子寫入保證的是「檔案內容不會被截斷、且改名本身已 flush」，不是「資料已持久化到磁碟」。`sync_all()` 只保證資料離開程式與作業系統快取，硬碟本身的寫入快取（尤其外接 USB 碟）仍可能因斷電遺失最後幾筆寫入；`fsync` 目錄同理，只把 flush 要求送到裝置。
- 匯入只讀取資料夾第一層的 `.txt`，不遞迴子資料夾；單檔上限 8 MiB，且必須是 UTF-8。
- 圖片張數、每張大小與資料夾是否存在仍是明文可見的 metadata；檔名本身是隨機 hex，不洩漏內容或原始檔名。manifest 內容（順序、MIME、尺寸）在 SQLCipher 裡；DB 檔大小仍會透露大約的日記量。
- 完整備份是設定頁匯出的 `.tar`：`VACUUM INTO` 快照 + `vault.xml` + `recovery.xml` + `attachments/`。只複製執行中的 `diary.db` 不是一致快照，請先鎖定並 checkpoint，或使用內建匯出。快照只寫 live pages，不含 free list；`diary.db` 本身仍可能有已刪除資料的殘留。
- 刪除後的 page 可能留在 SQLite free list；`secure_delete=ON` 會先把內容歸零再加密，但仍建議刪除後 checkpoint 並定期 `VACUUM`。
- 圖片會在前端重新編碼成 1000px WebP，EXIF（含 GPS）會被移除；若 WebView 不支援 WebP 編碼，PNG／WebP 來源會 fallback PNG 保留透明，其他格式則 fallback JPEG（透明區填白）。1000px 在 2x 螢幕全螢幕檢視時可能偏軟。
- 圖片功能是相簿，不是圖文混排：文字仍是純文字 textarea，不能把圖片插在段落中間。
- 孤兒附件（附件資料夾沒有對應的 `entries` 列）可由 `list_orphan_attachments` / `delete_orphan_attachments` 處理，目前沒有自動刪除；這是刻意的，避免刪到剛好還沒寫入 DB 的圖片。
- 圖片只支援相簿順序，不支援把同一張圖同時放在多個日期或同一天多個位置；每個檔案只有一個 id，刪除就是刪除。
- 行動版仍沒有「把日記本體放在外部資料夾」的選擇器，也沒有 `.txt` 資料夾匯入：`pick_diary_dir` 固定回傳 App 私有資料夾，`pick_import_dir` 直接回報不支援。備份檔可透過系統檔案選擇器存到外部位置。
- Linux 的剪貼簿圖片讀取使用 X11（arboard）。純 Wayland 且沒有 XWayland 的環境可能讀不到剪貼簿圖片；此時仍可用「加入圖片」或拖放。
- 原生拖放（`onDragDropEvent`）與原生剪貼簿備援目前只在桌面版；行動版仍以檔案選擇器與 WebView 的 paste 事件為主。
- 手機版排版只依視窗寬度判定：平板橫向仍是桌面兩欄，桌面把視窗縮到 `640px` 以下也會進入兩層式版面（即使使用滑鼠）。這是刻意的，讓同一份前端在桌面與 Android WebView 都能運作。
- 平行掃描與舊 XML 遷移的加速幅度受磁碟限制；SQLCipher 寫入以單一 transaction 序列化，不會因核心數增加而亂序。DB 無法開啟時只能從加密備份還原，因此請定期匯出。
- 匯入時標題固定取自檔名（`YYYY-MM-DD`），檔案內容全部視為日記本文；若想要自訂標題，匯入後再手動修改即可。
- 目前只有繁體中文與英文兩種語言；後端回傳的錯誤訊息（例如 Rust 端的 `Failed to write entry ...`）仍是英文，尚未翻譯。
- 變更日記路徑不會搬移既有檔案，需自行複製；新路徑若已有 vault 則會直接跳到解鎖畫面，沿用該 vault 的密碼。
- 設定檔本身未加密，任何人可讀到日記資料夾位置（但沒有密碼仍無法解密內容）。
- 檔案權限收緊只在 Unix 生效（`0600` / `0700`）。Windows 上沿用 `%APPDATA%` 既有的 per-user ACL，程式本身不額外設定 ACL；若把日記放在共用磁碟或同步資料夾，請自行確認該處的權限設定。
- AAD 綁定只保護「搬檔」與「索引／日記互換」這類攻擊。若攻擊者同時能改寫檔名與檔案內容，仍可把某一天的密文連同檔名一起搬走——AAD 綁的是檔案自稱的日期，不是外部可信的時間來源。
- 記憶體抹除只保證「程式主動抹除」。`release` profile 設了 `panic = "abort"`，panic 時不會執行 `Drop`，因此 `LockedKey` 的 zeroize／munmap 不會發生；不過行程會立刻結束，作業系統會回收該記憶體（core dump 已由 `RLIMIT_CORE = 0` 關閉）。
- session key 已放進 `LockedKey`（mlock + `MADV_DONTDUMP` / `MADV_WIPEONFORK`），Windows 另排除 WER dump；但 `mlock` 是盡力而為，且**不阻止休眠**：hibernation 會把整份 RAM 寫到磁碟。App 會盡量在 suspend 前鎖定，但若需要在休眠映像中也不留下金鑰，請使用加密 swap／加密休眠或在系統層停用休眠。
- 記憶體保護只涵蓋長時間存活的 session key。`session_key()` 的暫時副本、AES key schedule、Rust 配置器曾使用過的頁面，以及 webview 內的明文都可能不在鎖定頁內；root 權限的攻擊者也不受 `PR_SET_DUMPABLE` 限制。
- 全文搜尋索引保存解鎖期間所有日記的明文標題與內容，且不在 `mlock` 頁內；鎖定時會清除並 zeroize，但休眠映像與行程記憶體 dump 仍可能帶走它。索引不會寫入日記資料夾，關閉 App 後不留下任何副本。
- 前端（webview 內的 JS）持有解密後的標題與內容字串，V8 的 GC 不會抹除這些字串。鎖定時前端會清空編輯器，但無法保證舊字串已從記憶體消失；這是架構性限制。
- `String` / `Vec` 擴容時，舊緩衝會被釋放但不會抹除。`pack` 已用 `Vec::with_capacity` 預留大小避免擴容，但 `String::from_utf8_lossy(...).to_string()` 這類轉換仍會產生無法抹除的暫時副本。
- Linux 不提供 AppImage。AppImage 會打包自己的 GTK，並把 `GTK_IM_MODULE_FILE` 指向打包內的 `immodules.cache`，而該 cache 不含 `im-ibus.so` / `im-fcitx.so`，因此輸入法在 AppImage 內無法切換。請改用 `.deb` / `.rpm`，它們使用系統的 GTK 與系統的輸入法模組。
- Android 專案由 Tauri 產生在 `src-tauri/gen/android`，已列在 `.gitignore`；安全性覆蓋由 `scripts/harden-android.mjs` 套用，重新產生專案後要再跑一次。換一台機器建置時需要自備 Android SDK／NDK 與 Rust target；目前 repo 沒有 iOS 專案。
- Android 備份匯出沒有背景服務：只在使用者按下「匯出備份」並選好檔案後執行。App 被關閉或鎖定後不會自動備份；是否把 `.tar` 複製到雲端或另一台裝置，由使用者自行負責。
- Android 的存檔位置選擇器使用 SAF document provider；provider 不一定支援 seek 或原子替換，但備份只寫入一個新檔，不覆寫現有日記資料庫。
- 防止截圖在 Windows、macOS 與 Android（`FLAG_SECURE`）生效。`tao` 沒有 Linux 實作，`set_content_protected` 在 Linux 上是空操作，X11／Wayland 下截圖與錄影仍可取得視窗內容；若需要，請改用 Wayland 的 screencast portal 權限控管或 compositor 層的規則。
- 防止截圖擋的是「作業系統的擷取 API」，不是「看到畫面」。手機拍螢幕、虛擬機／hypervisor 層的擷取、外接擷取卡、以及核心層或注入式工具都不受影響；Windows 上 `WDA_EXCLUDEFROMCAPTURE` 也需 Windows 10 2004 以上。
- 防止截圖在「切換工作區」的資料夾選擇期間會暫時關閉（那裡只顯示路徑），選完或取消後恢復；若在意這段空窗，請避免在分享螢幕時切換工作區。
- 回復短語是 12 個**英文** BIP39 單字；目前沒有繁中或其他語言的 wordlist，也不接受使用者自訂短語。
- 回復短語只顯示一次，之後無法查看。忘記短語且忘記密碼時，資料無法救回。
- 短語包裝存在 `recovery.xml`；刪除或損毀該檔會讓短語失效。備份與還原時要讓 `vault.xml`、`recovery.xml` 與日記檔保持同一組，不要只還原其中一個。
- 以較舊的備份還原整個資料夾時，舊的 `vault.xml`、`recovery.xml` 與舊密碼／短語也會一起回來；目前沒有 diary key 輪換功能，所以外流的舊 `vault.xml`／`recovery.xml` 無法真正撤銷。改密碼只重新包裝同一把 diary key，不會讓舊檔失效。
- 舊 `recovery.xml`（v1）沒有 `vault-id`／`key-id`，只能維持舊 AAD；下次成功復原或重新產生短語時才會升級成 v2。
- 「不可複製」只是 CSS 與事件攔截，不是安全邊界；開發者工具、螢幕截圖或相機仍可取得畫面上的單字。它的目的是提醒使用者親手抄寫，並避免剪貼簿同步把短語帶到雲端。
- 短語包裝以 128-bit 熵為輸入；有效安全強度是 128 bits，不是 256 bits。這是刻意的取捨：12 個字比 24 個字更容易正確抄寫，而 128 bits 仍遠超離線暴力破解。
- 產生與確認期間，短語會以明文存在 webview 的 JS 字串、DOM 與 Rust 的暫時緩衝中；`clearPhrase()` 會清空陣列與 DOM，但 JS 字串無法可靠抹除，和密碼欄位的限制相同。
