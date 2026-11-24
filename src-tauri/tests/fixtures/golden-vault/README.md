# Frozen golden vault

This directory is **test data**, not a scratch workspace. It contains a real
diary written by Fly Diary 2.2.0 on 2026-11-24, then frozen byte-for-byte.

`src-tauri/tests/golden_vault.rs` copies these files to a temporary directory
and unlocks them with the current code. If a dependency upgrade or a refactor
breaks backwards compatibility, the test fails even when a fresh
encrypt/decrypt round-trip would still pass.

## Contents

```text
vault.xml
recovery.xml
diary.db
attachments/6385e137b5feaf45f64cc7c0d5c42905.bin
```

| Field | Value |
| --- | --- |
| Passphrase (public test data) | `fly-diary golden fixture passphrase` |
| Recovery phrase (public test data) | `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about` |
| Entries | `2026-10-22` (not favourite), `2026-10-23` (favourite) |
| Attachment | 1×1 PNG, `2026-10-23`, id `6385e137b5feaf45f64cc7c0d5c42905` |
| Vault format | `vault.xml` version 3, `recovery.xml` version 2 |
| Argon2id parameters | 65536 KiB, 3 iterations, 1 lane |
| SQLCipher / SQLite | 4.20.0 / 3.54.1 |
| Diary database | `VACUUM INTO` snapshot, schema `user_version = 1` |

The fixture contains only synthetic content. The passphrase and recovery
phrase are deliberately public.

## Freeze rules

1. Do **not** regenerate the fixture to make a failing test pass. A failure
   means the current build can no longer read an existing diary; fix that
   instead.
2. The SHA-256 of every file is asserted in `golden_vault.rs`. Changing a byte
   requires intentionally updating those constants, which should be a separate
   reviewed decision.
3. A deliberate new storage format must get a **new** fixture directory (for
   example `golden-vault-v2/`) so this one keeps proving that old diaries still
   open. Never overwrite an existing golden vault.
4. Keep Git from rewriting line endings: `.gitattributes` marks the fixture
   files as non-text.
