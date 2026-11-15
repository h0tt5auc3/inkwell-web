# Inkwell sync format (v1)

The Android app and the web page share this format. Everything lives in the
Google Drive **app data folder** (`drive.appdata` scope). That folder is hidden
from the Drive UI, and only Inkwell's OAuth client can read it.

## Files

| File | Contents |
|---|---|
| `vault.json` | The data key, wrapped (see below) |
| `entry-<uid>.json` | One encrypted entry. `appProperties`: `updatedAt` (ms, as a string), `deleted` (`"0"`/`"1"`) |

`appProperties` are plaintext, so a client can tell which entries changed without
downloading them. They reveal only timestamps, which Drive's own modified time
reveals anyway.

## Crypto

- **Data key (DEK):** 32 random bytes. It encrypts every entry with AES-256-GCM,
  using a 12-byte random IV and a 16-byte tag appended to the ciphertext.
- **Passphrase key:** PBKDF2-HMAC-SHA256 over UTF-8(NFC(passphrase)), with a
  16-byte salt and 600,000 iterations, giving 32 bytes.
- **Recovery key:** 32 random bytes, shown as RFC 4648 base32 in dash-separated
  groups of 4. It is used directly as an AES-256 key.
- **AAD (additional authenticated data):** `inkwell-vault-pass`,
  `inkwell-vault-recovery`, or `inkwell-entry:<uid>`. Tying each entry to its own
  uid stops files from being swapped.
- **Base64:** standard alphabet, with padding.

```json
// vault.json
{ "v": 1,
  "kdf": { "alg": "PBKDF2-SHA256", "iter": 600000, "salt": "<b64>" },
  "pass":     { "iv": "<b64>", "ct": "<b64>" },
  "recovery": { "iv": "<b64>", "ct": "<b64>" } }

// entry-<uid>.json
{ "v": 1, "iv": "<b64>", "ct": "<b64>" }

// decrypted entry
{ "uid": "...", "title": "", "body": "", "mood": 4, "prompt": null,
  "reflection": null, "createdAt": 0, "updatedAt": 0, "deleted": false }
```

## Sync rule

The higher `updatedAt` wins, entry by entry. A deletion is written as a
tombstone (`deleted: true`, with empty text) rather than removing the file, so
other devices learn about it. Photos are not synced yet.
