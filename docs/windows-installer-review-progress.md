# Windows installer review follow-up

Scope: implement the five accepted architecture review recommendations in the existing source checkout. No Git initialization or release packaging.

| Task | Files / interface | Status |
| --- | --- | --- |
| Shutdown completion | document_shutdown and bootstrap; complete after acknowledgement or window destruction | Complete; 3 tests passed |
| Explicit executable path | NSIS -> helper main -> preflight; scoped filename resolved under target | Complete; helper suite 8 passed |
| Upstream template contract | NSIS hook guard, pinned template compilation, disposable smoke, Windows CI | Complete; actual template smoke passed |
| Process enumeration / handles | helper lib; keep final-handle path verification | Complete; shared enumeration and RAII reviewed |
| Session initialization | runtime_state and Pi runtime; once-only initialization, pure path lookup, preserve both stores | Complete; 5 tests passed, independent review clean |
| Update failure recovery | app_update, bootstrap, Pi admission; do not leave Pi disabled after failure/cancellation | Complete; 3 phase tests passed, scoped re-review clean |

Interfaces checked: helper process refactor preserves the API used by preflight; shutdown changes only its bootstrap caller; migration initialization stays in Pi manager construction; template tests exercise the explicit executable argument. No shared-file implementation ownership overlaps.

Decision: preserve the user's source-only workspace; Git-specific skill bookkeeping and commits do not apply. Test binaries and disposable installers are permitted validation artifacts, not release builds.

Final review found that aborting update cleanup could leave Pi permanently disabled.
The correction keeps download/save preparation cancellable, then retains worker-owned
guards through a non-cancellable install phase and restores runtime admission if
installation returns. Three phase tests passed; scoped re-review confirmed the
finding resolved without new actionable regressions.

Desktop Rust check passed with a temporary externalBin override (missing unbuilt
sidecar only), with 88 existing warnings. No official package was built.

## Closeout review

Final independent source review found no remaining blocking regression in the
reviewed installer, helper, updater, document shutdown or Pi migration paths.
Production build and release entry points stage the helper where the NSIS hook
expects it; the stock template remains in use.

The closeout run repeated all 19 focused tests successfully (8 helper, 5 migration,
3 document shutdown, 3 update phase). The earlier actual-template disposable
install/upgrade/uninstall smoke and desktop Rust check remain the integration
evidence. No further production code changes were needed during closeout.

Limits: hosted CI has been configured but not executed from this source checkout;
official signed packaging and a real end-to-end signed application update remain
unverified. No Git repository was initialized or installed Flowix modified.
