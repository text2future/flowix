# CLI and MCP access

`flowix mcp` exposes structured tools `flowix_read`, `flowix_write`, and `flowix_delete`. The compatibility `memo` tool (including legacy command strings) remains available only in full mode. New clients should use the scoped tools.

Set `FLOWIX_MCP_ACCESS` in the server process environment:

| Value | Exposed tools |
| --- | --- |
| `read` | `flowix_read` |
| `write` | `flowix_read`, `flowix_write` |
| `full` or unset | all three and legacy `memo` |
| any other value | none (fail closed) |

These settings constrain this MCP process, not direct CLI commands, filesystem access, or other APIs. A host requiring isolation must restrict those separately. MCP annotations are hints, not authorization. In full mode the legacy tool preserves old write and delete semantics, including optional versions; do not grant it to clients that require scoped access.

In the new tools, `write` and `delete` require the nonempty `expectedVersion` returned by `show`; an outdated value gives `VERSION_CONFLICT`. The version hashes note content, not object identity or history. `create`, `artifact.create`, collection `add` and `add-note` require a `requestId`. Collection request IDs deduplicate only within the current server process; after restart, inspect the collection before retrying because a duplicate may be created. Previously created legacy hashed notes retain their old lookup behavior. Ordinary note and artifact creation use `agent-requests.sqlite3` under the Flowix configuration directory; keys are scoped by notebook ID and operation, and receipts currently have no expiry. A completed request replays its original response; a different payload with the same key fails. The database can contain the returned note body, so it must be protected and backed up like notebook data.

A reservation is committed before side effects. Concurrent retries or any failed/interrupted operation without a recorded result return `REQUEST_INDETERMINATE`, even if failure occurred before a side effect. Inspect the notebook or artifact before deciding what to do; do not automatically retry with another key. Receipts are local to this configuration directory and do not deduplicate across independently configured or synced devices. This protocol provides at-most-once execution within that scope, not exactly-once delivery or automatic crash recovery.

List/search/collection pagination tokens detect changes in recomputed results. They are not historical snapshots; `DATA_CHANGED` requires restarting the scan. Output changes can occur during a scan and the token cannot guarantee a transactional view.

| Capability | CLI | Structured MCP |
| --- | --- | --- |
| Notes and search | yes | read/write/delete |
| Collections | yes | read/write |
| Plugin artifacts | yes | read/write |
| HTML capability catalog and templates | yes | not exposed |
| Editor component catalog and creation | yes | not exposed |

CLI `create` and `collection add-note` also accept optional `--request-id`; `collection add` already supported it. The CLI and legacy MCP retain their existing compatibility behavior when no key is supplied. Error categories `VERSION_CONFLICT` and `DATA_CHANGED` replace generic `CONFLICT` for the corresponding cases.

Schema compatibility checks can be run after building the CLI with `cargo build --manifest-path app/Cargo.toml -p flowix-cli`, followed by `node --test scripts/tests/flowix-mcp-schema.test.cjs`. Set `FLOWIX_TEST_CLI` if the binary is not in `app/target/debug/flowix-cli`. These checks cover representative contracts, not every MCP client or all schema inputs.

## Inspecting uncertain requests

`flowix request list --state uncertain --json` lists up to 50 local receipts (use `--limit`, at most 200; `truncated` indicates more). `flowix request show <request-id> --notebook <notebook-id> --operation <create|artifact.create> --json` shows a receipt and its review history. MCP read-only clients can use `request.list` and `request.show` through `flowix_read` with the same fields (`requestId` in MCP). These queries do not create or upgrade a ledger. Old records without metadata return null timestamps and hints.

After an explicit manual investigation, an operator can record `flowix request review <request-id> --notebook <id> --operation create --outcome confirmed --actor <name> --evidence <note-address> --json`, or use `--outcome unresolved` for either supported operation. `confirmed` currently supports ordinary notes only. Flowix checks that the evidence note exists in the same notebook; it does not establish that the note was created by the request. The actor is a self-reported label, not an authenticated identity. Reviews are observations: they do not change an uncertain receipt into a completed result, unlock the request, or authorize any retry. The original operation might still be running; completed and uncertain records are never automatically deleted.

Only ordinary note and artifact creation use this receipt ledger. Collection request IDs use the collection's separate retry mechanism and do not appear in these queries. Hints, error summaries, and reviews may contain sensitive paths or labels and should be protected like notebook data.
