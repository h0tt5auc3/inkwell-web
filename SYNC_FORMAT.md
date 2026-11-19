# Inkwell sync format (v1)

The Android app and the web page share this format. Everything lives in the
Google Drive **app data folder** (`drive.appdata` scope). That folder is hidden
from the Drive UI, and only Inkwell's OAuth client can read it.

## Files

| File | Contents |
|---|---|
| `vault.json` | The data key, wrapped (see below) |
| `entry-<uid>.json` | One encrypted entry. `appProperties`: `updatedAt` (ms, as a string), `deleted` (`"0"`/`"1"`) |
| `day-<yyyy-MM-dd>.json` | One encrypted daily check-in (the older format, still synced). `appProperties`: `updatedAt` (ms, as a string), `kind` (`"day"`) |
| `log-<yyyy-MM-dd>.json` | One encrypted quick log day. `appProperties`: `updatedAt` (ms, as a string), `kind` (`"log"`) |
| `pattern-notes.json` | The encrypted pattern notes (one file). `appProperties`: `updatedAt` (ms, as a string), `kind` (`"notes"`) |

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
  "reflection": null, "turns": [], "createdAt": 0, "updatedAt": 0, "deleted": false }
```

`turns` is optional (older files don't have it; treat a missing field as `[]`). It
holds the conversation that follows `body`, in order, as an array of
`{ "role": "me" | "ai", "text": "...", "at": <ms>, "engine": null | "ON_DEVICE" | "CLAUDE" }`.
`body` stays the user's original writing; `me` turns are their follow-up writing and
`ai` turns are AI replies (`engine` is `null` for `me` turns). Clients that edit an
entry keep `turns` exactly as they found it. `reflection` is the older single-reply
field: an entry with no `turns` but a `reflection` is shown as one `ai` turn, and
once the thread is edited the reflection is moved into `turns` and set to `null`.

## Daily check-ins (older format)

There is one `day-<yyyy-MM-dd>.json` file per calendar day, using the same data key
and the same envelope as entries (`{ "v": 1, "iv", "ct" }`). The AAD is
`inkwell-day:<yyyy-MM-dd>`. The decrypted JSON is:

```json
{ "date": "2026-03-05",
  "values": {
    "caffeine":  { "level": 2 },
    "brain_fog": { "yes": true, "times": ["09:15", "14:30"] },
    "alcohol":   { "yes": false },
    "meds":      { "yes": true } },
  "updatedAt": 0 }
```

`values` is keyed by tracker id. A tracker with no answer is absent, and null fields
are omitted, so "not recorded" differs from "no". `level` is an index (caffeine:
0 none, 1 a little, 2 medium, 3 a lot), `yes` is a boolean, and `times` are
24-hour `"HH:mm"` strings, sorted. Clients keep tracker ids they don't know.
Day files have no tombstones; the higher `updatedAt` wins, as for entries.

The app replaced the daily check-in with the quick log (below) but still syncs old `day-*` files unchanged. The web page never downloads or decrypts `day-*` files; check-ins are only shown in the Android app.

## Quick log

The quick log is a list of raw, timestamped events ("Coffee at 9:12", "Brain fog: moderate
at 14:30") logged from the home screen widget or the app. There is one
`log-<yyyy-MM-dd>.json` file per **local calendar day** (the phone's time zone when the
event happened), using the same data key and envelope as entries
(`{ "v": 1, "iv", "ct" }`). The AAD is `inkwell-log:<yyyy-MM-dd>`. The `appProperties`
`updatedAt` is the largest event `updatedAt` in the file, in ms as a string. The decrypted
JSON is:

```json
{ "date": "2026-11-17",
  "events": [
    { "id": "<uuid>", "item": "caffeine", "option": "coffee",
      "at": 1763391120000, "updatedAt": 1763391120000, "deleted": false } ] }
```

`at` is when the event happened and `updatedAt` is when that event last changed (both
epoch ms). `item` and `option` are ids from the app's catalog; clients keep ids they
don't know. The file holds every event, tombstones included, whose `at` falls in that day.

**Merge rule.** Events are merged one by one by `id`, not file by file: the higher
`updatedAt` wins, and on a tie a tombstone wins. A deletion sets `deleted: true` and
the event stays in the file as a tombstone; tombstones are kept and synced, never
dropped. The result is the union of the ids on both sides. An event can be filed under
another date (a time zone change or an edited time), so clients dedupe by `id` across
days. A client looks at a day when Drive's `updatedAt` differs from its own, downloads
and merges it, and writes the file back only if the merged content differs.

The web page never downloads or decrypts `log-*` files; the quick log is only shown in
the Android app.

## Pattern notes

`pattern-notes.json` is the journal's running memory: a short text Claude rewrites each
week from the entries and the quick log. There is exactly one file. It uses the same data key
and envelope as entries (`{ "v": 1, "iv", "ct" }`), with AAD `inkwell-pattern-notes`. The
decrypted JSON is:

```json
{ "text": "Recurring themes
• ...", "updatedAt": 0 }
```

The higher `updatedAt` wins (the `appProperties` copy is what clients compare without
downloading). Clearing the notes is a normal write with `"text": ""` and a new
`updatedAt`, not a deletion, so other devices pick the empty notes up. An empty or
missing file means "no notes".

The web page never downloads or decrypts `pattern-notes.json` (it only reads `vault.json`
and `entry-*.json`); the notes are only used in the Android app.

## Sync rule

The higher `updatedAt` wins, entry by entry. A deletion is written as a
tombstone (`deleted: true`, with empty text) rather than removing the file, so
other devices learn about it. Photos are not synced yet.
