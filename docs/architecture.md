# 架構與設計重點

[← 回到 README](../README.md) · [文件索引](README.md)

這一頁記錄專案結構，以及那些「看程式碼不一定看得出來」的設計取捨。

## 專案結構

```text
fly-diary/
├── src/                    # 前端（純 HTML/JS/CSS）
│   ├── index.html          # 解鎖畫面 + 編輯器（文字以 data-i18n 標記）
│   ├── main.js             # 編輯器、清單、自動儲存、invoke 呼叫
│   ├── dom.js              # DOM 查表（els），無副作用
│   ├── wiring.js           # 所有事件綁定，以 deps 注入回呼（可單獨測試）
│   ├── calendar.js         # 全螢幕日期選擇器（createCalendar）
│   ├── import-dialog.js    # 匯入對話框：掃描、進度、報告（createImportDialog）
│   ├── stats-dialog.js     # 統計對話框：卡片與長條圖（createStatsDialog）
│   ├── settings-dialog.js  # 設定對話框：日記本、自動鎖定、KDF、改密碼（createSettingsDialog）
│   ├── recovery-dialog.js  # 一次性 BIP39 短語、獨立確認視窗（createRecoveryDialog）
│   ├── word-input.js       # BIP39 單字磁磚與前綴建議（共用於確認／解鎖）
│   ├── lock-screen.js      # 解鎖畫面、vault 偵測、KDF 校準、短語解鎖（createLockScreen）
│   ├── attachments.js      # 圖片相簿：壓縮、上傳、排序、lightbox（createAttachmentGallery）
│   ├── native-drop.js      # 桌面原生拖放：路徑事件與編輯區 hover 判定
│   ├── focus-trap.js       # modal 的 Tab／Shift+Tab 焦點圈禁與還原
│   ├── i18n.js             # 多語系字典、t()、日期在地化
│   ├── lib/
│   │   ├── dates.js        # 純日期運算（可單獨測試，無 DOM 依賴）
│   │   └── stats.js        # 統計運算（連續天數、月度/星期分佈）
│   ├── styles.css          # 入口：以 @import 載入 styles/ 的 partials
│   └── styles/
│       ├── tokens.css      # 色彩、字體、間距、dark theme
│       ├── base.css        # reset、焦點、共用 primitive、app shell
│       ├── lock.css        # 解鎖／建立 vault 畫面
│       ├── sidebar.css     # 搜尋、篩選、虛擬滾動列
│       ├── editor.css      # 編輯器標頭與日期導覽
│       ├── calendar.css    # 全螢幕月曆
│       ├── editor-body.css # 標題、內容、唯讀狀態
│       ├── attachments.css # 圖片相簿與 lightbox
│       ├── controls.css    # footer、字級控制、按鈕
│       ├── dialogs.css     # 匯入、設定、回復短語、統計
│       ├── scrollbar.css   # 自訂捲軸
│       └── responsive.css  # 斷點、觸控、hover、reduced motion
├── tests/                  # 前端測試（node --test）
│   ├── helpers/
│   │   ├── dom.js          # 極簡 DOM stub（fakeElement / installDom / fakeInvoke）
│   │   └── css.js          # 展開 styles.css 的 @import，供 CSS invariant 測試
│   ├── dates.test.js
│   ├── stats.test.js
│   ├── i18n.test.js
│   ├── wiring.test.js      # 快捷鍵分派、對話框開關、debounce、手機返回鈕
│   ├── calendar.test.js    # 月曆格線、焦點移動、月份切換、月份摘要、捲動鎖定
│   ├── import-dialog.test.js   # 掃描結果、覆蓋、進度、報告
│   ├── stats-dialog.test.js    # 統計卡片、長條圖比例
│   ├── settings-dialog.test.js # 日記本路徑、匯入/統計/路徑轉交、自動鎖定、KDF、儲存驗證
│   ├── recovery-dialog.test.js # BIP39 短語、獨立確認視窗、前綴建議、取消/失敗不留資料
│   ├── attachments.test.js     # 1000px 縮放、相簿順序、上傳/刪除、唯讀、lightbox
│   ├── native-drop.test.js     # 原生拖放：hover 判定、drop 路徑、離開/取消
│   ├── styles.test.js          # CSS 不變量：hidden 疊層、月曆/lightbox z-index、手機兩層排版
│   ├── docs-links.test.js      # README 與 docs/ 的相對連結、文件索引可達性
│   ├── a11y.test.js            # 表單標籤、live region、對比、target size
│   ├── focus-trap.test.js      # modal Tab 循環與焦點還原
│   └── lock-screen.test.js     # 解鎖/建立 vault、路徑切換、上鎖
├── src-tauri/              # Rust 後端
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json
│   ├── gen/                # Tauri 產生的行動版專案（gitignored）
│   ├── icons/
│   ├── tests/
│   │   ├── vault_lifecycle.rs      # 整合測試：建立→寫入→上鎖→解鎖→讀回
│   │   └── attachments_lifecycle.rs # 附件：新增→排序→上鎖→解鎖→刪除
│   └── src/
│       ├── main.rs         # 進入點；關閉 core dump 與同使用者記憶體存取
│       ├── lib.rs          # Tauri commands、解鎖 session、blocking() 與 mobile/desktop 分支
│       ├── settings.rs     # 設定檔（日記路徑、自動鎖定、自動儲存延遲）讀寫
│       ├── crypto.rs       # 金鑰派生、KDF 校準、AES-256-GCM、recovery key 展開
│       ├── bip39.rs        # BIP39 英文單字編碼／解碼、checksum、確認位置、wordlist 查詢
│       ├── bip39_english.txt # 官方 BIP39 英文 wordlist（2048 字，編譯時嵌入）
│       ├── fsutil.rs       # 原子寫入／複製、fsync 目錄、0600/0700 權限
│       ├── secure_memory.rs # 鎖定頁存放 diary key（mlock／VirtualLock、防 dump/fork）
│       ├── xml.rs          # XML 序列化 / 解析
│       ├── attachments.rs  # 圖片附件：加密檔、manifest、順序、孤兒掃描
│       ├── clipboard.rs    # 桌面剪貼簿圖片讀取（WebKitGTK paste 備援）
│       └── storage.rs      # vault、recovery.xml 與加密日記的檔案儲存層
├── docs/                   # 文件（security / file-format / ui / accessibility / architecture / development / reference）
├── .github/
│   ├── dependabot.yml      # npm / Cargo / Actions 每週更新
│   └── workflows/
│       ├── ci.yml          # PR 測試（Actions 全部 pin 到 SHA）
│       ├── security.yml    # cargo audit + pnpm audit（PR 與每週排程）
│       └── release.yml     # 建置、發佈與 build provenance
├── .npmrc                  # ignore-scripts + prefer-frozen-lockfile
├── test.sh                 # 一次跑完兩邊測試與 coverage
├── package.json
└── README.md
```

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
- **匯出不重新序列化**：`export_broken_entry` 用 `fsutil::copy_private` 逐位元組複製原始檔案，不經過 XML 解析再輸出。壞檔的價值就在於它「壞掉的部分」，重新序列化會丟掉未知元素與屬性，反而讓人工搶救更困難。複製同樣走「暫存檔 → `sync_all()` → `rename`」，所以匯出中途失敗只會留下原本的目標檔，不會產生一份看起來成功、其實被截斷的搶救檔。
- **圖片不改日記格式**：附件放在 `attachments/YYYY-MM-DD/`，以日期資料夾當關聯，日記 XML 完全不動。舊日記沒有這個資料夾，`list_attachments` 回空清單；舊版 App 也會忽略它。這是 sidecar 設計的核心。
- **固定順序是資料，不是檔名**：manifest 內 `<attachment>` 的元素順序就是顯示順序。新增 append、拖曳只重寫 manifest；不依賴 mtime、檔名或 `added-at`，所以重開、換裝置、同步後都不會亂。
- **每張圖獨立加密**：圖片各自有 IV 與 AAD（綁日期、id、版本），單張損壞不會影響其他圖片；manifest 用不同 AAD label，不能和 index 或日記密文互換。
- **附件刪除方向固定**：新增是「圖片 → manifest」，刪除是「圖片 → manifest 移除」；crash 只會留下未引用圖片（會被補回）或遺失佔位，不會讓已刪除的圖片復活。刪除日記則是 index → XML → 附件資料夾。
- **虛擬滾動**：側邊欄只渲染視窗內可見的列（外加少量 overscan），捲動時以 `index * 列高` 絕對定位。列高由 CSS 的 `--row-h` 決定、JS 用 `getComputedStyle` 讀回，因此字級改變時列高會跟著變，不會出現捲動錯位。即使有上萬篇日記，DOM 節點數也維持在數十個。
- **單一縮放來源**：所有尺寸都是 `rem`，根字級 = 流動 `clamp()` × 使用者倍率。改一個變數就縮放整個介面（含內距、圖示、日曆），不必為每個元件寫縮放邏輯。
- **CSS 用原生 `@import` 拆分**：入口 `src/styles.css` 只負責載入 `src/styles/*.css`，順序就是 cascade 順序；沒有 PostCSS／Sass／打包步驟，Tauri 與測試都直接讀同一組檔案。`tests/helpers/css.js` 會展開 `@import`，讓 CSS invariant 測試仍然看到完整規則。
- **手機版只換版面、不改資料流**：`data-layer` 只決定哪一層可見；選日期、存檔、鎖定、壞檔處理都走與桌面版相同的函式。返回鈕只是 `showListLayer()`，不會卸載編輯器，也不會丟棄尚未儲存的內容。
- **翻譯與程式分離**：靜態文字用 `data-i18n` 屬性標在 HTML 上，動態文字走 `t()`，字典集中在 `i18n.js`。`main.js` 裡不再有硬編碼的中文字串，新增語言不必碰 UI 邏輯。
- **日期不靠字串拼接**：`formatDate` / `formatMonth` / `formatWeekday` 各自負責一種格式，中文用「年月日」、英文用 `MM/DD/YYYY`，避免把 `年`、`月` 寫死在程式裡。
- **匯入分兩階段**：`scan_import` 只讀不寫，把每個檔案分類成「可匯入／已存在／失敗」並附上原因；使用者確認後才由 `run_import` 寫入。檔名是日期與標題的唯一來源，不是合法 `YYYY-MM-DD` 就判為失敗，不做猜測。
- **檔名即標題**：匯入時 `2026-10-23.txt` 的標題就是 `2026-10-23`，整份檔案（去掉 BOM、統一換行）原封不動成為內容。不從內容偷一行當標題，匯入因此是無損的，標題也永遠是資料夾裡看得到的東西。
- **匯入容錯**：單一檔案失敗不會中斷整批，報告會分別列出成功、略過與失敗的檔案；索引在整批寫完後只重建一次。
- **平行匯入**：掃描與寫入都跑在 rayon 執行緒池上。每個日期對應自己的檔案，讀檔、AES-GCM 加密、寫檔互不競爭，唯一共享的狀態是索引，因此整批只在最後寫一次 `index.xml`（若改用 `write_entry` 逐筆寫，會變成 N 次索引重寫並把整批序列化）。結果依使用者確認的順序折回，報告順序穩定。
- **不卡 UI**：`scan_import` 與 `run_import` 都是 `async` 命令，透過 `spawn_blocking` 把整批工作移出主執行緒；`run_import` 另以 `import-progress` 事件回報 `{done, total}`，對話框按鈕會顯示「匯入中… 12/340」。
- **金鑰階層**：密碼只派生 master key，master key 只包裝隨機的 diary key。改密碼或升級 KDF 時只需重新包裝 diary key，不必動到任何日記檔。
- **可調 KDF**：首次建立 vault 時可在「進階選項」調整 Argon2id 的記憶體／迭代／平行度，參數寫入 `vault.xml`，之後解鎖沿用同一組參數；設定頁可隨時再調整。
- **改密碼只重包金鑰**：`rewrap_vault` 用舊密碼解開 diary key、用新密碼與新 salt 重新包裝，只改寫 `vault.xml`。日記與索引完全不碰，所以不會有「改到一半壞掉」的風險，速度也不受日記數量影響。
- **KDF 校準先高後低**：從 64 MiB 開始往下砍記憶體，第一次測量就是上限，慢機器不會先被一組過重的參數卡住；剩餘預算再換成迭代次數。平行度固定 1，讓結果可重現。
- **閒置計時器只有一個**：所有活動事件都只是重設同一個 `setTimeout`，不累積計時器；鎖定與關閉設定頁時一併清除，避免背景殘留。
- **設定頁需要解鎖才能開**：改密碼要驗證目前密碼、讀參數要讀 vault，所以設定頁只在解鎖後可達；鎖定時會自動關閉並清空密碼欄位。
- **金鑰不落地**：金鑰只存在 `Mutex<Session>` 中並以 `Zeroizing` 包裝，`lock()` 或程式結束即抹除。
- **抹除貫穿整條金鑰路徑**：`unlock_vault` / `create_vault` / `rewrap_vault` / `migrate_legacy_vault` 都直接回傳 `Zeroizing<[u8; 32]>`，不再經過裸 `[u8; 32]` 的堆疊副本；`crypto::decrypt` / `decrypt_with_aad` 回傳 `Zeroizing<Vec<u8>>`，所以解出來的明文（包含被包裝的 diary key）在離開作用域時自動歸零。`pack` / `pack_index` 產生的明文緩衝同樣是 `Zeroizing`，`Entry` 實作 `Drop` 抹除 `title` 與 `content`。`run_import` / `upgrade_entries` 從 session 取出的金鑰副本也包在 `Zeroizing` 裡，批次結束即抹除。
- **關閉 core dump**：`main()` 在 Unix 上把 `RLIMIT_CORE` 設為 0；Linux／Android 另外設定 `PR_SET_DUMPABLE = 0`，讓同使用者無法用 `ptrace` 或 `/proc/<pid>/mem` 讀取行程記憶體。兩者一起擋掉「崩潰後把金鑰寫到磁碟」與「其他行程直接讀記憶體」。
- **密文綁定日期與版本（AAD）**：日記 payload 以 `日期 || 0x00 || 版本` 作為 AES-GCM 的 associated data，索引則用固定標籤。搬動或複製檔案、或改寫 `<diary version="…">` 想降級成較弱的 AAD 規則，都會讓驗證標籤對不上而解密失敗，不會安靜地顯示錯誤那天的內容；索引與日記密文也無法互換。
- **背景升級不擋 UI**：`upgrade_entries` 是 `async` 命令，實際改寫跑在 `spawn_blocking`，並以 `upgrade-progress` 事件回報 `(done, total)`。`enterApp()` 刻意不 await，所以解鎖後立刻能寫日記，升級在背後慢慢跑完。
- **升級是冪等且原子的**：已升級的檔案直接跳過，中斷後下次解鎖自動續跑；寫入前會把新密文解回來比對明文、並比對 mtime，因此既不會留下半截檔案，也不會覆蓋使用者同時存下的編輯。
- **所有寫入都是原子的**：`fsutil::write_private` 一律「寫同目錄暫存檔 → `sync_all()` → `rename` 覆蓋」。`rename` 在 POSIX 上是原子操作，所以斷電、磁碟滿、行程被 kill 都只會留下「完整的舊檔」或「完整的新檔」，不會出現截斷的檔案。`sync_all()` 不可省：少了它，`rename` 可能先於資料落地，斷電後會得到一個檔名正確但內容為空的檔案。暫存檔名帶有 pid 與遞增序號，因此平行匯入（rayon 池同時寫多篇）不會互撞同一個暫存檔。失敗路徑會清掉暫存檔，不留下垃圾。這對 `vault.xml` 尤其關鍵——它只有幾百 bytes，卻裝著 salt、KDF 參數與包裝後的金鑰，一旦截斷就等於日記永久無法解鎖。附件圖片與每日 manifest 也走同一條路徑，所以新增／排序／刪除不會留下半截檔案。
- **`rename` 之後再 fsync 目錄**：`sync_all()` 只保證「檔案內容」落地，`rename` 改的是**目錄項目**，那是另一份中繼資料。少了目錄的 flush，斷電後可能出現「新內容在磁碟上、但檔名還指向舊 inode」的狀態。`fsutil::replace` 因此在 `rename` 之後對父目錄做一次 `fsync`（`fsutil::sync_dir`）。這在多裝置同步下格外重要：同步軟體是照目錄項目決定要上傳哪個版本，若改名沒落地，另一台裝置可能把舊檔「復活」回來，覆蓋掉剛寫好的新內容。
- **Windows 用 `ReplaceFileW` 換檔**：Windows 的 `rename` 不能覆蓋既有檔案，舊做法是「先刪再改名」，中間存在「兩者都不存在」的空窗。現在 `fsutil::replace` 在 Windows 上直接呼叫 `ReplaceFileW` 並帶 `REPLACEFILE_WRITE_THROUGH`，由核心一次完成替換並寫穿，空窗消失。因為 `libc` 只是 Unix 的依賴，這段 FFI 是手動宣告的（`#[link(name = "kernel32")]`），只編譯在 Windows 上。
- **檔案權限收緊**：所有寫入都走 `fsutil::write_private`，Unix 上檔案固定 `0600`、目錄 `0700`，不依賴行程 umask。`OpenOptions::mode` 只在建立檔案時生效，因此 `rename` 之後會再 `set_permissions` 一次，把舊版留下的 `0644` 一併收緊；已存在的日記資料夾（例如使用者自己挑的 `0775` 資料夾）也會清掉 group/other 位元。`vault.xml` 內含 salt、KDF 參數與包裝後的金鑰，是離線暴力破解的完整材料，因此最需要這層保護。
- **CSP 不含 `unsafe-inline` script**：`script-src` 只允許 `'self'`，並加上 `object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`。前端沒有任何 inline `<script>`、`on*=` 屬性或 `eval`，所以拿掉 `unsafe-inline` 不影響功能；`style-src` 仍保留 `unsafe-inline`，因為 JS 會直接設定 `element.style`。
- **防止截圖**：視窗以 `contentProtected: true` 建立，Tauri 會轉成 Windows 的 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 與 macOS 的 `NSWindow.setSharingType(.none)`，讓截圖工具與螢幕錄影／分享只看到黑畫面。鎖定畫面同樣受保護；只有開啟「切換工作區」選擇資料夾時，前端才透過 `set_screenshot_protection` 暫時解除，因為那裡只顯示路徑、使用者可能正想分享螢幕，選完或取消後立刻恢復。
- **本地時區**：`today()` 用 `chrono::Local`，前端日期運算也用本地 `Date`，避免 UTC 跨日問題。
- **所有 I/O 命令都不佔主執行緒**：Tauri 的同步命令跑在主執行緒上，所以任何碰檔案或做真正加密的命令都會凍住 webview。`async fn` 本身不夠——函式體沒有 `.await` 就會在第一次 poll 一路跑到完成，仍然佔住一條 runtime worker。因此 `lib.rs` 提供一個 `blocking()` 輔助函式包住 `spawn_blocking`，**所有會做 I/O 的命令都經過它**：`save_entry`、`get_entry`、`delete_entry`、`save_attachment`、`list_attachments`、`get_attachment`、`delete_attachment`、`reorder_attachments`、`list_orphan_attachments`、`delete_orphan_attachments`、`set_favourite`、`list_entries`、`list_favourites`、`rebuild_index`、`list_broken_entries`、`scan_import`、`export_broken_entry`、`diary_path`，以及設定檔的 `get_settings` / `set_diary_dir` / `set_auto_lock` / `set_autosave_delay` / `vault_exists` / `get_vault_kdf`。只有 `lock`、`is_unlocked`、`get_kdf_defaults`、`today` 這種讀一個欄位或常數的命令維持同步。
- **Argon2id 一定離開主執行緒**：`unlock`、`create_vault`、`change_passphrase` 各要跑一到兩次刻意放慢的 Argon2id 派生（單次約一秒），是最容易讓人感覺到凍結的地方。三者都改為 `async` 並把派生交給 `blocking()`；session 只在工作回傳後才寫入，因為 `tauri::State` 無法 move 進 `spawn_blocking`。
- **金鑰先複製再交給背景執行緒**：`MutexGuard` 不是 `Send`，也不能讓鎖跨越整個寫入過程（會擋住 `lock` 與其他命令）。所有需要金鑰的命令都先用 `session_key()` 把 `[u8; 32]` 複製出來，再 move 進閉包；鎖只持有到複製完成為止。
- **存檔的四次往返**：寫入一篇日記包含讀取舊檔（取回收藏旗標）、加密寫入、解密索引、重新加密寫入索引。自動儲存延遲可設定（最小 200 ms），所以這條路徑會頻繁觸發，這也是它必須離開主執行緒的原因。
- **資料安全**：自動儲存 + 切換日期前強制存檔 + 鎖定前強制存檔。
