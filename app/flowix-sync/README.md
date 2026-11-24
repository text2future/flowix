# Local Cloud modules

## Ownership

- `account/` owns login sessions, credential persistence and recovery, entitlement verification, AI account APIs, and billing APIs. `AccountService` can run without a `SyncManager`.
- `account/access.rs` projects verified account data into `CloudSyncAccess`. It is the client-side source for read, upload, and delete capabilities; Cloud independently checks entitlements before issuing storage credentials.
- `manager/v4_engine.rs` resolves the selected storage target, refreshes official-cloud credentials at request boundaries, and invokes the path-keyed pass. `manager/account_api.rs` keeps account operations available through `SyncManager` for existing desktop call sites.
- `v4_pass.rs`, `v4_apply.rs`, `reconcile.rs`, and `object_store.rs` contain the path-sync planning, local apply contract, reconciliation rules, and S3-compatible transfer protocol.
- `store/` owns SQLite transactions for account data and path-sync state. The path tables store per-notebook baselines, directory scans, pending stamps, and retry state; they do not implement a cloud change cursor.
- `remote.rs` freezes a custom S3 target for the lifetime of a manager. Credentials are supplied by the selected target's setup path and are not written into this crate's sync state.

## Desktop boundary

`flowix-desktop/.../commands/cloud/coordinator.rs` serializes sync passes and schedules retries. `path_sync_runner.rs` scans the notebook and builds the path-pass input; `v4_adapter.rs` implements the filesystem operations required by the sync engine, including guarded replacement and local version archives. `local_adapter/` owns path validation, safe file operations, and visible conflict-copy handling.

The path protocol has no indexed-sync cursor, bootstrap snapshot, or server revision. New code should keep account policy, local filesystem work, object transfer, and path-state persistence in their owning modules. `CloudState.syncAccess` exposes the native capability projection to the web UI; the UI grants no access while it is missing and does not re-evaluate membership rules.

## Checks

- `cargo test --manifest-path app/Cargo.toml -p flowix-sync -- --test-threads=1`
- `cargo check --manifest-path app/Cargo.toml -p flowix-desktop`
- `npx vitest run app/flowix-web/lib/cloud-account.test.ts app/flowix-web/features/preferences/hooks/use-cloud-account-state.test.tsx`

When a local test transport is routed through a development proxy, exclude `127.0.0.1` and `localhost` for Rust HTTP fixtures.
