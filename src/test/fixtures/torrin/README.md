Torrin answers used by the Torrin client tests (`src/services/torrin.test.ts`).

## Source-derived

`source-derived-06a40e41.json` was built by hand from Torrin's source at commit `06a40e41`
(torrin-app/torrin, 2026-11-08), not captured from a live account. Each entry is
`{status, body}` and follows the code that writes it, field for field:

- `api/internal/stremthru/stremthru.go`: the `{data: ...}` envelope (`stJSON`), the
  `{error: {code, message}}` error with `code` equal to the HTTP status (`stError`), the auth
  check's 401 `invalid api key` and 403 `subscription paused/expired, ... at https://torrin.app`
  (`withAuth`), the user (`getUser`, whose `subscription_status` is always `premium`), the magnet
  object (`magnetDataLite`, `magnetDataForTarget`), its file entries (`buildFileEntries`,
  `fileEntry`), and the four statuses (`stStatus`).
- `api/internal/stremthru/magnets.go`: the add's answers for a held release (`downloaded` with
  files) and a new one (`queued`, no files, size 0, the magnet's `dn` as name), its 403
  `this release requires a paid plan`, its 429 `monthly download limit reached, resets on the 1st`
  and `download queue full` (`stQueueError`), its 400 `invalid magnet`, the delete's 204 with no
  body and its 409 while seeding, and the 404 `not found` for an id the account does not own.
- `api/internal/stremthru/check.go`: one item per hash asked, `cached` with files and links,
  `acceleratable` and `unknown` without.
- `api/internal/middleware/ratelimit.go`: the request limiter's 429, whose body is
  `{"error":"rate limit exceeded"}` with a plain string, unlike every other error.
- `shared/mediainfo/mediainfo.go`: the optional `media_info` fields.

Ids are placeholders shaped like the UUIDv7s Torrin mints. Mail is a placeholder. Every stream link
is replaced whole with `stream.example.test` and placeholder `exp`/`sig` parameters, because the
real ones are signed and work as a key to the file for 24 hours. The releases are Blender open
movies with their well-known v1 info hashes. Names, sizes, dates and media info are illustrative.

## Recorded

None yet. Replace each entry with an answer captured from a real account when one exists
(`src/services/torrin.live.test.ts` reads the same routes), list here what it shows, and point the
tests at it. The tests read only this file, so swapping an entry is the whole change.
