# 安全政策

## 支援版本

| 版本    | 支援 | 說明                              |
| ------- | ---- | --------------------------------- |
| `2.2.x` | ✅   | 第一個正式版；接受安全修正        |
| `< 2.2` | ❌   | PoC／pre-release，不再提供修正    |

## 回報漏洞

請**不要**開公開 issue。使用 GitHub 的私人漏洞回報（Repository → Security →
Report a vulnerability），或寄信到 <me@worldofwheat.cc>。

請盡量包含：

- 受影響的版本或 commit
- 重現步驟或 PoC
- 影響（例如讀取日記、繞過解鎖、金鑰外洩、備份竄改）
- 你希望的揭露方式

維護者會盡快確認；這是個人專案，沒有 bug bounty。修補完成後會協調揭露時間。

## 範圍

- 加密與 KDF（Argon2id、HKDF、AES-GCM、AAD）
- SQLCipher 儲存、`vault.xml`／`recovery.xml`、備份／還原／匯入
- Android 生物辨識與 Keystore 包裝
- 記憶體保護與鎖定行為
- CI／release 供應鏈（lockfile、Action pinning、provenance）

## 不在範圍

- 需要實體接觸已解鎖裝置、root／注入工具或記憶體 dump 的攻擊，除非能繞過文件宣稱的邊界
- 使用者自行外洩密碼、回復短語或備份檔
- 已列在 [docs/security.md 的已知限制](docs/security.md#已知限制) 的行為

## 安全模型與稽核狀態

本專案尚未經獨立第三方安全稽核。威脅模型、金鑰階層與已知限制見
[docs/security.md](docs/security.md)。
