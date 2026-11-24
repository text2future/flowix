# Cloud storage release acceptance

This checklist covers path-keyed object storage sync. The old indexed protocol has no real users and is outside the launch scope. Do not import or clean up old protocol objects as part of release acceptance. Do not reset a shared bucket to run these checks; use a disposable account and notebook.

This checklist separates code implementation from environment acceptance. “Implemented” means the code path exists; it does not count as a passed release gate. Every runtime row remains open until an operator records the build, backend, account type, date, and observed result.

Use `Pending` until evidence is recorded; `Failed` means the expected result did not occur; `Blocked` means the environment was unavailable; `Passed` requires the expected result and evidence; `Deferred` is allowed only for an explicitly excluded backend such as COS while its write scope remains disabled. A blocked or deferred applicable gate is not a pass.

## Release gates

| Gate | Action | Expected result | Status |
|---|---|---|---|
| Sync suite stability | On the exact release commit, run `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1` three times in separate processes | All three runs complete without SIGABRT, timeout, or skipped tests | Local working tree passed 3/3 on 2026-11-23; exact release-commit CI Pending |
| Engine cutover | Use a clean account with the release client; inspect the coordinator and runtime status to confirm only the path engine runs | First sync starts from local files without invoking the indexed sync pass; credentials are limited to that account's object prefix | Implemented; runtime verification Pending |
| Notebook registry | Create, rename, reorder, and delete a notebook on device A, then sync device B | Manifest state converges; tombstoned notebooks do not reappear; unrelated notebooks remain unchanged | Implemented; two-device verification Pending |
| File content | Sync nested Markdown, binary attachments, empty Markdown files, Unicode paths, and case-sensitive paths where the filesystem permits | Object keys preserve notebook-relative paths; bytes and SHA-256 match on both devices | Implemented; two-device verification Pending |
| Empty directories | Create nested empty directories on A and sync B; then delete a directory on A | Directory hierarchy appears on B, including empty leaves; deletion converges without deleting unrelated content | Implemented; two-device verification Pending |
| Collection and hidden content | Sync `.index.yaml`, collection definitions, hidden files and hidden directories between devices, including changes and deletions | Eligible content converges; `.flowix` private configuration, dependency directories and temporary files remain excluded | Automated boundary checks; two-device verification pending |
| Notebook settings | Migrate existing `folder_index` rows, then edit folder appearance on two devices | `.flowix/database/notebook_settings.json` synchronizes; remote changes refresh folder appearance; concurrent edits use file conflict handling | Unit coverage; two-device verification pending |
| Conflict preservation | Disconnect both devices, edit the same file differently, reconnect A then B | LWW winner converges; losing bytes are in a visible conflict copy and a `ConflictBackup` archive | Pending |
| Concurrent object replacement | With two clients and the same baseline, coordinate writes so one PUT lands between the other's PUT and HEAD, then repeat with the replacement immediately after HEAD | A HEAD whose `contentHash` differs from the submitted bytes does not advance local state; a later remote replacement is applied only after the old local bytes enter bounded version history; both clients converge on the surviving object | Pending |
| Download integrity and live local edits | Corrupt or mismatch a downloaded object's declared hash; separately edit a note while a remote replacement is being applied | Hash mismatch leaves local bytes and baseline unchanged; a concurrent local save is never silently overwritten | Pending |
| Remote deletion | Delete a file remotely while the other device has a local edit; also test deletion of an unchanged local file | Local edits are preserved before removal; remote deletion converges; `RemoteDeletion` archives follow the 20-version cap | Pending |
| Interrupted transfer | Interrupt upload and download mid-transfer, restart, and run another pass | Partial bytes never replace a complete local file; retries converge without duplication | Pending |
| Quota guard | For R2, verify a fresh measured snapshot, stale-snapshot refresh, at-limit downgrade, and measurement failure downgrade | Only a successful object-store measurement from the last five minutes can authorize writes; read scope still downloads | Implemented; real R2 verification Pending |
| Delayed PUT and sweep recovery | On an isolated R2 prefix, use a fault-injection proxy to hold one file PUT in flight, let the client cancel and retry its queued directory stamp, then forward the held PUT; run a successful forced sweep | The client never records unverified bytes as clean; the next successful full sweep discovers the final object state and both clients converge, with any cloud-only intermediate version loss treated as the accepted LWW limit | Pending; no real R2 cancellation/reordering record |
| R2 staging readiness | Inspect the staging deployment without exposing secret values; enable direct transfers only after credentials and isolated bucket scope are configured | `BLOB_DIRECT_TRANSFERS` is enabled for staging and the R2 signing credentials are present and prefix-limited | Passed 2026-11-23: staging enabled and real prefix-scoped credentials exercised; test parent token expires 2026-12-23 |
| Cloud worker CI | Run the `flowix-cloud` CI check on the exact worker commit intended for deployment | Layer checks, TypeScript, and the complete Vitest suite pass; deploy only that checked commit | Workflow implemented; current release commit must pass |
| Production D1 migration | Apply migrations through `0020_storage_usage_snapshot_source.sql` before deploying worker code that reads the source field; inspect schema and foreign keys | Existing snapshot rows remain present and classified; `usage_source` has the expected constraint/default; `PRAGMA foreign_key_check` returns no rows | Passed 2026-11-23: production migration applied; row count preserved, `usage_source=ledger`, schema/default and indexes verified, no foreign-key violations |
| Mainland backend | Keep COS write scope disabled unless mainland storage is included in the launch | If enabled, list, upload, download, tombstone write, quota measurement, and retry all pass from a mainland network | Deferred: COS is outside the initial R2-only launch |
| Bucket rebind | Rebind a disposable account to a fresh empty bucket while local unsynced edits exist | Deletes remain suppressed; local edits are not overwritten or removed | Pending |
| Large notebook | Run a full client sync and clean-device restore with 10,000 files and representative attachments; record duration, peak memory, largest file size, and transfer failures | All files converge without partial success being reported as clean; duration and peak memory meet budgets written down before the run | Pending; scanner-only and raw R2 listing measurements do not pass this gate |
| Recovery | Install on a second clean machine and bind the same account | Notebook identity, directory structure, file bytes, and attachments reconstruct; local index/display configuration stays local | Pending |

## Automated check record

Record focused Rust, cloud worker, and UI checks here with the date and exact command. Passing unit or simulation tests do not substitute for the R2 bucket or two-device gates above.

| Date | Command | Result |
|---|---|---|
| 2026-11-24 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1` after adding the bulk-delete guard | 173 unit tests and 3 integration tests passed; none ignored. Working tree only. |
| 2026-11-24 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync mass_remote_deletion -- --test-threads=1` | Passed: a simulated 20-file remote deletion aborts planning twice without changing the existing 20 path baselines or writing objects. This is not a real R2 test. |
| 2026-11-24 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1`, three separate runs | Each passed 171 unit and 3 integration tests, none ignored. Working tree based on `67ee8772` contains uncommitted changes; this is not exact-release-commit CI. |
| 2026-11-24 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop commands::cloud:: --lib -- --test-threads=1` | 41 passed; 5 real R2 tests ignored because disposable staging fixtures were unavailable. |
| 2026-11-24 | `cargo test --manifest-path app/Cargo.toml -p flowix-core sync_path_tests -- --test-threads=1`; same command with `path_version_tests` | 2 path-boundary tests and 3 archive tests passed. |
| 2026-11-24 | `npm run check` in `flowix-cloud` | Layer and type checks passed; 47 test files and 323 tests passed. Working tree based on `141d33f` contains uncommitted changes; this is not deployment-commit CI. |
| 2026-11-24 | `npx vitest run test/p0-account-mock.test.ts` in `flowix-cloud` | 7 storage-credential route tests passed using the user-supplied email as a fixture in an isolated local database, a synthetic user ID and test keys. The temporary test copied `storage-routes.test.ts` with only the fixture email changed and was removed afterward. No real account or R2 was accessed. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-core sync_path_tests -- --test-threads=1` | 2 passed: local configuration paths are excluded; `.flowix/database/` user records and eligible directories remain syncable. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync v4_apply::tests -- --test-threads=1` | 9 passed, including rejection before local archive/delete. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync v4_apply::tests -- --test-threads=1` | 10 passed after adding a remote-delete race test: an edit after archival stays on disk and the deletion remains pending. This is not a two-device acceptance. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync v4_apply::tests -- --test-threads=1` | 13 passed, including simulated tombstone races, interrupted and corrupt downloads and a successful retry. Real R2 and two-device gates remain open. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync object_store::tests -- --test-threads=1` | 11 passed, including simulated expired-token renewal. Real long-running renewal remains pending. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1 --skip account::deletion` | 154 unit tests and 3 integration tests passed; 4 account deletion tests filtered. Includes a simulated cancelled pass with a completed action checkpoint. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1 --skip account::deletion` | 158 unit tests and 3 integration tests passed. Includes durable stamp retry after cancellation, read-only downgrade and failed PUT, plus account/target isolation; 4 account deletion tests filtered. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync account::deletion -- --test-threads=1` | 4 passed in a separate process; this does not establish that the previously observed full-suite SIGABRT flake is fixed. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1` | 162 unit tests and 3 integration tests passed, including account deletion. One successful run does not establish that the earlier intermittent SIGABRT is fixed. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1` run three times after fixing the account-deletion HTTP test server's accepted-socket mode | All three runs passed: each had 162 unit tests and 3 integration tests, with zero failures and zero skipped tests. Repeat on the exact release commit in GitHub Actions. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync a_deleted_account_reports_the_deadline_and_can_be_restored_explicitly -- --test-threads=1` run ten times | All ten passed after the test server explicitly restored blocking mode on accepted sockets. |
| 2026-11-23 | `npm run check` in `flowix-cloud` | Layer check and typecheck passed; 46 test files and 364 tests passed. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-core path_version_tests -- --test-threads=1` | 3 passed, including corrupt manifest rejection and deduplicated archives for syncable user data. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop commands::cloud::v4_adapter::tests -- --test-threads=1` | 10 passed; 5 real R2 tests ignored because staging fixtures were not supplied. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop commands::cloud::v4_adapter::tests -- --test-threads=1` | 9 passed, including read/write/delete/create/remove protection for local configuration and retained `.flowix/database/` sync. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop conditional_delete_preserves_changed_notes_and_attachments -- --test-threads=1` | Passed: changed Markdown and attachment bytes are not removed, and successful note deletion clears its projection. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop commands::cloud::v4_runner::tests -- --test-threads=1` | 7 passed, including partial-error details, index-config exclusion, empty-directory scanning, and visible over-limit path errors. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1` | 176 passed. |
| 2026-11-23 | `cargo check --manifest-path app/Cargo.toml -p flowix-desktop` | Passed; compiler reports remaining dead-code and interface warnings, including unused old v2 adapter code. |
| 2026-11-23 | `cargo check --manifest-path app/Cargo.toml -p flowix-desktop` after removing the indexed-sync client API and orphan engine source | Passed. Existing warnings remain, including unused legacy desktop conflict-adapter helpers; no Rust tests were rerun for this cleanup. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1` after updating the `RemoteSelection::select_s3` tests to its current signature and pruning unused account-refresh glue | 162 unit tests and 3 integration tests passed; no failures or ignored tests. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop commands::cloud:: --lib -- --test-threads=1` | 36 passed, 5 ignored live-R2 tests require disposable staging fixtures. |
| 2026-11-23 | `cargo check --manifest-path app/Cargo.toml -p flowix-desktop` after removing unreachable conflict adapters and imports | Passed. Existing warnings remain elsewhere in desktop/core; no warnings remain for the removed cloud conflict helpers. |
| 2026-11-23 | `cargo fmt --manifest-path app/Cargo.toml --all -- --check` | Passed after formatting the changed Rust workspace sources. |
| 2026-11-23 | `node --check` over JavaScript files under `public/`, `scripts/`, `test/`, and `src/`; Ruby YAML parse and OpenAPI reference check | Passed: JavaScript syntax valid; OpenAPI has 8 active paths and 20 component references resolve. |
| 2026-11-23 | `npm run check` in `flowix-cloud` | Layer check and typecheck passed; 44 test files and 354 tests passed. |
| 2026-11-23 | `cargo fmt --manifest-path app/Cargo.toml --all -- --check`; `git diff --check` in `flowix-main` and `flowix-cloud` | Passed. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync reconcile::simulation -- --test-threads=1` | 10 passed, including offline conflicts, remote deletion with unsynced edits, rename, and stale listings. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync v4_pass::tests -- --test-threads=1` | 23 passed, including failed listing/probe, rebind, pagination, and read-only quota behavior. |
| 2026-11-23 | `npm run check` in `flowix-cloud` after migration 0020 | Layers and typecheck passed; 45 test files, 355 tests passed, including preservation of pre-existing snapshot data and safe ledger provenance. |
| 2026-11-23 | `npm run check` in `flowix-cloud` after measurement pagination fix | Layers and typecheck passed; 45 test files, 357 tests passed. |
| 2026-11-23 | `npm run check` in `flowix-cloud` after retiring the indexed-sync HTTP routes and stale blob transfer helpers | Layers and typecheck passed; 46 test files, 347 tests passed. The old `/v2/sync/*` and `/v2/blobs/*` paths return 404. |
| 2026-11-23 | OpenAPI YAML parse and local component-reference check | Passed: 8 active paths parse and all component references resolve; retired sync and blob paths are absent. |
| 2026-11-23 | `npm run check` in `flowix-cloud`; `node --check public/admin/app.js`; OpenAPI YAML parse | Layers/typecheck passed; 46 test files and 348 tests passed. Account export now labels its legacy index and states that current path-keyed objects/file contents are excluded; admin storage metrics label object-store byte measurements separately from historical index/cleanup fields. JavaScript syntax and the 8-path OpenAPI document parse passed. |
| 2026-11-23 | `npm run check` in `flowix-cloud` after removing unreachable actor sync/reservation commands and stale bootstrap mock support | Layers/typecheck passed; 45 test files and 316 tests passed. Removed commands return `INVALID_OPERATION`; historical index export and delayed cleanup of `uploads` rows remain tested. No tables or bucket objects were cleared. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1 --skip account::deletion` | 175 passed, four skipped. The unfiltered suite aborted in the known `account::deletion` SIGABRT flake. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop live_r2_two_local_stores_transfer_notebook_content -- --ignored --test-threads=1` | Passed against real staging R2 with disposable scoped credentials and two separate local databases. The test is not a two-device UI acceptance. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop live_r2_list_ten_thousand_objects -- --ignored --test-threads=1` | Passed against a disposable R2 fixture; the production listing source read 10,000 objects in 10 pages in 20.33 seconds. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop live_r2_single_device_login_upload_and_restart -- --ignored --test-threads=1` | Passed against real staging: authenticated, published note and attachment, wrote notebook manifest and empty-directory marker, reopened the local sync database, authenticated again, rediscovered the notebook and made a clean no-transfer pass. This does not exercise the Tauri window, session restore from Keychain, or a second physical device. |
| 2026-11-23 | `cargo test --manifest-path app/Cargo.toml -p flowix-desktop live_r2_invalid_credential_reports_error_without_changing_local_data -- --ignored --test-threads=1` | Against real staging R2, an invalid credential returned an error without changing local bytes or recording a baseline; retry with a valid credential uploaded the file and persisted its baseline. |

For each runtime gate, append a separate record with: gate name and result; operator and UTC date; desktop commit/build and Cloud commit/deployment; backend and region; disposable account alias and quota; exact command or UI steps; observed result and timing; log/artifact location; defect link or reason blocked. Never record credentials or bearer tokens.

Staging database migration `0020_storage_usage_snapshot_source.sql` was applied on 2026-11-23. The resulting schema includes `usage_source` and accepts the `unknown` default; `PRAGMA foreign_key_check` returned no violations. Three existing snapshots were present and classified as `ledger`. Production migration `0020` was applied on 2026-11-23 after confirming the configured production database ID and checking the pre-migration table (one row, no orphaned user references). Post-migration, the row count remained one and the row was classified as `ledger`; the `ledger` default, `unknown` read-status default, source/status constraints, both indexes, and `PRAGMA foreign_key_check` were verified. Wrangler reports no remaining production migrations.

## R2 staging smoke record

On 2026-11-23, staging Worker version `756ee023-3425-470e-b49f-2cf06f6a00da` was deployed with direct transfers enabled. A disposable staging-only account with a temporary storage grant received a read-write credential scoped to its own `u/<uid>/` prefix. Real R2 PUT, HEAD, GET, and LIST returned HTTP 200; downloaded bytes matched the uploaded bytes. A PUT to another user prefix returned HTTP 403.

For quota verification, the disposable account's grant was reduced to one byte and its snapshot made stale. The next credential request measured the real bucket at 44 bytes and returned a read credential with `usageSource=object_store` and `readStatus=ok`. GET still returned 200 and PUT returned 403. The test left an isolated synthetic account and one probe object in its prefix; it did not remove any existing bucket data. Bucket-unavailable, paging-limit, token expiry, transfer interruption, and desktop two-device acceptance are still Pending, so this smoke record does not close the full R2 or quota gates.

On 2026-11-23, staging Worker `5abd77c5-8484-49ea-bc0a-4a39cd8855c2` included the increased measurement page cap. A separate disposable account uploaded 10,000 small objects to R2 in 461.9 seconds using a 32-request test harness. After forcing its snapshot stale, the real control-plane measurement returned 119,177 bytes, `object_store`/`ok`, and a read-write credential in 10.439 seconds. This is a storage/API measurement, not the duration of the desktop sync engine. The fixture remains in its isolated account prefix.

Live two-local-store testing found two defects that fake listings did not expose: returned object keys carried the user prefix, and R2 LIST and HEAD exposed different timestamp precision and ETag quoting. The client now strips and validates the prefix, rejects incomplete listings, and normalizes ETag comparisons. A repeat real R2 run transferred note, attachment, and `.flowix/database/` content, left each device's `.index.yaml` local, and preserved both a visible conflict copy and version archive for an offline edit. The production Tauri UI, manifest/empty-directory lifecycle, interrupted transfers, and a second physical machine remain unverified.

An initial real desktop-adapter sample of 100 files took 192.27 seconds and reported six network request failures; it did not pass. A second isolated 100-file sample completed in 131.81 seconds with no transfer failures and 100 persisted path states. Neither result proves that the six failures from the first sample recover on a later pass; a separate real test did verify recovery after a rejected credential. These measurements used the client engine, not the 32-request raw object-store harness. End-to-end 10,000-file transfer and credential renewal remain open.

## Local scan measurement

On 2026-11-23, a standalone debug-profile harness called `flowix_core::memo_file::scan_syncable_notebook_tree` five times on a temporary notebook on an Apple M4 macOS machine. The fixture had 10,000 small Markdown files in 100 directories, 20 attachments of 256 KiB each, and a nested empty directory. The scanner reported 10,020 files and 103 syncable directories on every run. Timings were 355.094, 342.244, 345.532, 338.076, and 343.057 ms; `/usr/bin/time -l` reported a 7,831,552-byte maximum resident set for the standalone process across all five scans.

This is a warm-cache, local scanner measurement, not a full sync pass or a release-build benchmark. It excludes client baseline processing, network, object-store operations, and a clean-device restore. No desktop performance budget is recorded yet, so the large-notebook release gate remains Pending until a budget is agreed and a representative end-to-end measurement is recorded.

## Recovery and deletion guard

An individual failed transfer keeps its path pending for a later pass; a failed listing is not evidence for deletion. Local bytes are archived before a remote deletion or replacement. A pass is blocked with `CLOUD_MASS_DELETE_BLOCKED` when its planned local deletions and outgoing tombstones total at least 20 and at least half of known path baselines. The error aborts the pass before file transfers or deletion checkpoints; binding changes can already have been recorded while planning. Inspect the notebook and remote state, restore unintended missing files from the local archive or another verified copy, then retry. For intentional bulk deletion, restore enough files to unblock and delete in reviewed smaller batches. Do not clear the sync database or change buckets to bypass the guard.

This is a per-pass safety net, not a guarantee against deletions spread across separate passes or fewer than 20 paths. It does not cover notebook manifest or directory-marker deletions. Archive availability and restore UI must still be verified on the target client.

## Performance and backend admission baseline

The existing local scanner and R2 samples above are measurements, not end-to-end budgets. For an initial single-device baseline, use a disposable account and isolated local directory; record build and deployment IDs, machine, region, network, fixture sizes, duration, peak memory, transferred counts, failures and byte/hash verification. Measure 100, 1,000 and 10,000 files for initial upload, idle pass, one-file edit, and interrupted-upload retry. Separately restore the same fixture into a clean local profile; do not reuse a real user's data. Set time and memory budgets before the release run from representative product requirements, not from an incomplete sample. Until the runs and budgets exist, performance admission remains Pending.

For every backend before enabling writes, verify on the real service: prefix isolation; complete pagination and error handling; server Date, LastModified and ETag behavior on replacement; metadata and SHA-256 round trips; empty file versus tombstone; interrupted PUT/GET and retry; quota measurement failure and read-only downgrade; and recovery after a failed directory stamp followed by a full sweep. Record region, service configuration, fixture and evidence separately. Mock tests are necessary regression checks but do not qualify a backend. R2 is the initial target; COS writes remain disabled pending its own real-service checks.

The desktop currently derives its configuration and application-data directories from the user's home and system data directory. Starting a second process with the same user does not establish independent device state. Use genuinely isolated client profiles or separate machines for the two-device acceptance; do not use the existing user profile as a disposable test account.

## Two-device run record

Run this sequence with two signed-in release builds and separate local notebook directories. Keep the disposable account and bucket prefix isolated from shared staging data.

1. Create a notebook, nested folders, and an empty folder on A. On B, list the cloud notebooks, choose A's notebook, select a local directory when prompted, then sync and compare identity and directory structure. Set folder appearance on A and confirm it remains local to A.
2. Add a Markdown note and attachment on A; confirm B receives identical bytes and hashes.
3. Disconnect both devices. Edit different files, reconnect A then B, and confirm both changes converge.
4. Edit the same note on both devices, reconnect A then B, and verify the losing bytes appear in a conflict file and local archive.
5. Delete one file on A while editing it offline on B; verify B's edit is archived before the remote deletion is applied.
6. Rename a folder during an interrupted transfer; restart both devices and confirm there are no missing or duplicate files after convergence.
7. Fill a disposable account to its configured capacity; verify new writes defer while downloads continue.
8. Record client build IDs, Cloud deployment ID, backend/region, account storage limit, date, and results for each gate above.

## Go / no-go

Release is **No-go** while any of these remain true:

- notebook manifest or empty-folder sync is missing;
- private `.flowix` configuration is transferred between devices;
- the client runs both indexed and path engines over the same user data;
- any of three consecutive release-commit `flowix-sync` runs aborts, times out, or skips tests;
- the Cloud worker CI check is red or has not run against the exact deployment commit;
- object-store measurement failure can grant write access;
- real R2 object and quota acceptance has no completed record;
- COS is enabled for writes without a real bucket smoke test;
- conflict or deletion paths can remove local bytes before archival;
- concurrent PUT/HEAD, remote replacement, or live local edits can leave a false clean baseline or overwrite unarchived bytes;
- interrupted transfers, delayed PUT completion, or the periodic full-sweep recovery path have not passed their applicable runtime checks;
- the 10,000-file end-to-end sync and clean-device restore have not passed with recorded duration and peak-memory budgets;
- two-device acceptance has no completed record.

The accepted LWW limit is that an extreme concurrent race can lose an intermediate version that existed only in cloud storage. This does not waive verification of local edit preservation, archives, hashes, visible errors, or eventual convergence after a successful full sweep. COS remains out of scope while its write credentials stay disabled.

Old-protocol import and compatibility are not release gates. Existing cloud objects remain untouched; any future cleanup requires a separately scoped retention decision.
