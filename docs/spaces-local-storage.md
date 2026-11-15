# Spaces on the orchestrator's disk

Spaces keep their files in S3. That needs an AWS account with the `termag-spaces-<account>-<region>-an` bucket, the `termag-spaces-presigner` role the orchestrator can assume, and the `alias/termag-spaces` KMS key (`backend/src/services/spaces/spaceConfig.ts`). For a small installation, one orchestrator host and a handful of people, that is a lot of setup for some shared disk. Local storage keeps the same spaces on a directory on the orchestrator host instead.

This page is the plan and, as the parts land, the reference. Status per step is at the end.

## Why it fits

Spaces already reach storage through one interface, `SpaceObjects` (`services/spaces/spaceObjects.ts`). Only `spaceObjects.ts` imports the S3 SDK; routes, the sweeper and the scripts get their `SpaceObjects` from `spaceObjects()` in `spacesRuntime.ts`. `MemorySpaceObjects` in `spacesTestkit.ts` is a second implementation the tests use.

The clients are thin on the storage side. The browser (`frontend/src/services/spaceTransfer.ts`) and the CLI (`cli/src/space.ts`, which box agents use) PUT bytes to the URL they were given with the headers they were given, read the `ETag` response header, treat 412 as "it changed since you read it", and GET download URLs. They parse nothing from S3 but an optional `<Code>` in an error body. So when the orchestrator signs its own URLs and answers them itself, no client changes.

Sizes fit the gateway: a single PUT is at most `SINGLE_PUT_MAX_BYTES` (64 MiB) and a multipart part is `PART_BYTES` (64 MiB), both under nginx's `client_max_body_size` on `/termag`.

## Design

### 1. `LocalSpaceObjects` (`services/spaces/localSpaceObjects.ts`)

Implements `SpaceObjects` on a directory, with S3's semantics where the rest of spaces depend on them:

- **Versioned, like the bucket.** Conditional writes (`PutCondition`), restore, the landed check (`spaceVersions.ts`) and quota accounting (`sumVersions`) all assume every version is kept and a delete is a marker.
- **Layout.** A key `<spaceId>/<path>` maps segment by segment onto directories: a directory segment is `d.<segment>`, the object itself is `o.<segment>/`. The prefixes let a file `a` and a folder `a/` coexist as they do in S3, and no name on disk is `.` or `..`. A segment over 200 bytes is stored as `D.<sha256>` / `O.<sha256>` with the real segment in a `name` file beside it. `spacePaths.ts` already refuses empty, `.` and `..` segments, backslashes and control characters, and every method also refuses a key that would escape the root.
- **An object directory** holds `index.json`, the key's versions and delete markers oldest first (version id, ETag, size, content type, time, the `termag-upload` metadata), and one immutable data file per version, named by its version id.
- **Writes** stream to `tmp/` under the root (same filesystem), then commit under a lock on the key: check the condition, link the data in, rewrite `index.json` by write-and-rename. The 412 is decided inside that lock, which is the guarantee S3 gives. The lock is a `mkdir` lock so two orchestrator processes on one host (an update's handover) serialise too; a lock older than 30 seconds is taken as stale.
- **ETags** are 32 hex digits in quotes, with `-<parts>` after a multipart upload's, and distinct per version even for the same bytes, as the bucket's SSE-KMS ETags are: the landed check finds a write among the versions by its ETag. A part's ETag is its MD5, as S3's is. Clients treat them all as opaque.
- **Copy and restore** hard-link the immutable version file instead of copying bytes. Quota still counts each version's size, as S3 bills a copy.
- **Multipart** parts live in `uploads/<uploadId>/`; complete checks each part's ETag, concatenates them into `tmp/`, then commits like a PUT with the upload's condition. `sweepMultipart` aborts uploads started before its cutoff, as on S3.

### 2. Signed storage URLs (`routes/spaceStorage.ts`)

`presignGet`, `presignPut` and `presignParts` answer URLs under `${FRONTEND_URL}${BASE_PATH}/api/space-storage/<token>`. The token is a base64url JSON payload (operation, key, exact size, content type, condition, upload proof, upload id and part number, expiry) and an HMAC-SHA256 over it with a key derived from `SESSION_SECRET`. Like a presigned S3 URL it is a bearer: no session cookie, because the CLI on a box has none.

- **PUT** (object or part): refuses a token that is expired, tampered with or for another operation (403), a `Content-Length` that isn't the signed size or a `Content-Type` that isn't the signed type (403, as S3 refuses a signature mismatch), and a body that runs past the declared size. It streams to `tmp/`, commits, and answers `ETag`. A failed condition answers 412 with `<Error><Code>PreconditionFailed</Code></Error>`, which the CLI and browser already turn into "changed".
- **GET**: serves the current version with Range support (the PDF viewer and `<video>` seek), the signed `Content-Disposition` and `Content-Type`, and its ETag. 404 `NoSuchKey` when there is none.
- **Same-origin hardening.** S3 serves from another origin; these files come from termag's own. Every response sends `X-Content-Type-Options: nosniff`, and every type outside a short allowlist (raster images, PDF, audio, video) also gets `Content-Security-Policy: sandbox`, so an uploaded HTML or SVG file opened from its URL runs no script in termag's origin. PDF is allowed unsandboxed because Chrome's viewer refuses to render in a sandboxed document. HTML link pages are already answered sandboxed by `spaceLinks.ts` and are unaffected.
- The router is mounted before `express.json()`, which would otherwise consume an upload whose content type is `application/json`.

### 3. Choosing the backend

`SPACES_STORAGE=local` with `SPACES_LOCAL_DIR` (default `/var/lib/termag/spaces`) selects local storage; `spacesRuntime.ts` then builds `LocalSpaceObjects` and never calls STS. Unset keeps S3. It is an explicit choice, not a fallback when AWS is missing, so a deployment meant for S3 never quietly writes to local disk. This departs from `spaceConfig.ts`'s "spaces have no env of their own", and its comment should say so. The orchestrator logs which backend it uses at the first spaces request.

### 4. Tests

- `localSpaceObjects.test.ts`: versions, delete markers, conditions (racing writers included), copy with `sourceIfMatch`, restore, listing with and without delimiter and paging, long and dot-named segments, multipart, sums, purge, sweep. Running one suite against `MemorySpaceObjects` too would need its test shortcuts (fixed list ETags, sizes it makes up for multipart) reconciled first.
- Route tests for tokens (expiry, tampering, wrong operation), size and type checks, 412, Range, and the hardening headers.
- An e2e mode that runs local storage in place of Floci (`docs/e2e-stack.md`).

### 5. Docs

`docs/agents/configuration.md` (the two variables), the Space entry in `docs/agents/domain-model.md`, a gotcha for same-origin serving, and an index line in `AGENTS.md`.

## Trade-offs

- **One host.** Several orchestrator processes on one host share the directory and its locks; several hosts do not. Local storage is for single-host installs.
- **No KMS.** Files are plain on disk unless the volume is encrypted.
- **Backups.** The directory is not in the database's backups; back it up with the host. A container deploy needs a volume for it.
- **Moving to S3 later** needs a copy script (`scripts/moveAutomationFolders.ts` is a precedent); copying current versions only is the simple first cut.
- **No per-identity audit in CloudTrail.** `space_events` still records who did what.

## Status

| Step | State |
|---|---|
| 1. `LocalSpaceObjects` | Done (`services/spaces/localSpaceObjects.ts`, tokens in `spaceStorageTokens.ts`) |
| 2. Signed storage URLs | Done (`routes/spaceStorage.ts`), not yet mounted in `index.ts` |
| 3. Choosing the backend | Not started: mount the router, select in `spacesRuntime.ts`, call `cleanTmp()` at startup |
| 4. Tests | Unit and route tests done; e2e mode not started |
| 5. Docs | Not started |
