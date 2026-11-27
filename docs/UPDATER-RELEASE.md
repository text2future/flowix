---
key: luofjg67
---

# Flowix updater release

Flowix ships per-platform update manifests and static website downloads:

- **Per-platform updater manifests** under stable R2 paths, served directly to
  the in-app updater. Each one advertises exactly one release platform
  group's binaries and pins its own top-level `version`.
- **Tencent COS artifacts** (`versions/...`) that the manifests point at. Their
  filenames include the release version. Flowix updater archives are signed with
  the Tauri updater key; the client verifies the `.sig` value from the HTTPS
  manifest before installation. The standalone DSH runtime is also checked
  with SHA-256 and the same Tauri/Minisign signature before installation.

Signed updater archives and installer downloads live in Tencent COS under `${FLOWIX_COS_PUBLIC_BASE}/${FLOWIX_COS_PREFIX}/` (default: `/versions/`). Per-platform updater manifests remain on Cloudflare R2 under `${FLOWIX_R2_PUBLIC_BASE}/${FLOWIX_R2_UPDATER_PREFIX}/`; installed clients keep using the stable `download.flowix.cc` manifest endpoint, while the package URLs inside those manifests point directly to COS. macOS, Windows, and Linux can ship on independent cadences —
macOS can publish `1.3.0` while Windows stays on `1.2.4` without confusing
either client into a self-install loop.

Manifests include `notify: true` by default. Set `FLOWIX_UPDATE_NOTIFY=false`
when publishing a release that should remain available to manual checks but must
not show the automatic status-bar update button. The release is still detected
by the updater and can be installed from Preferences.

## Manifest layout

| Manifest                          | Consumer             | Stable URL                                       |
| --------------------------------- | -------------------- | ------------------------------------------------ |
| `updater/macos/latest.json`       | Flowix custom updater | `https://download.flowix.cc/updater/macos/latest.json`      |
| `updater/windows/latest.json`     | Flowix custom updater | `https://download.flowix.cc/updater/windows/latest.json`    |
| `updater/linux/latest.json`       | Flowix custom updater | `https://download.flowix.cc/updater/linux/latest.json`      |

Each per-platform manifest's `platforms` block contains only its own group:

| Manifest                | `platforms` keys                        |
| ----------------------- | --------------------------------------- |
| `updater/macos/...`     | `darwin-aarch64`, `darwin-x86_64`       |
| `updater/windows/...`   | `windows-x86_64`                        |
| `updater/linux/...`     | `linux-x86_64`                          |

The updater picks the manifest containing
its current OS-arch key, so a misconfigured binary that points at the wrong
group manifest will fail the update check rather than silently offering nothing.

## Release scope

`scripts/release.sh` infers the release scope from `FLOWIX_TARGETS`:

- **Full release** — uploads covered artifacts to COS, publishes per-platform
  manifests to R2, and rebuilds/deploys flowix-home when macOS is included.
- **Partial release** — uploads only the covered artifacts and manifests; a
  macOS release that includes both architectures also rebuilds/deploys
  flowix-home so its two installer links stay current.

## Environment overrides

| Variable                            | Default                                              | Notes |
| ----------------------------------- | ---------------------------------------------------- | ----- |
| `FLOWIX_COS_BUCKET`                 | `flowix-downloads-1307208156`                        | Tencent COS bucket for installers and updater archives |
| `FLOWIX_COS_REGION`                 | `ap-guangzhou`                                       | COS bucket region |
| `FLOWIX_COS_PREFIX`                 | `versions`                                           | COS key prefix for installers and signed updater artifacts |
| `FLOWIX_COS_PUBLIC_BASE`            | `https://flowix-downloads-1307208156.cos.ap-guangzhou.myqcloud.com` | Public COS object origin |
| `TENCENT_COS_SECRET_ID` / `TENCENT_COS_SECRET_KEY` | —                                  | CAM credentials with `PutObject` access to the bucket; uploads use the Tencent COS Node SDK without multipart permissions |
| `FLOWIX_R2_UPDATER_PREFIX`          | `updater`                                            | R2 key prefix for per-platform manifests |
| `FLOWIX_R2_BUCKET`                  | `flowix-downloads`                                   | Existing Cloudflare R2 bucket serving updater manifests |
| `FLOWIX_R2_PUBLIC_BASE`             | `https://download.flowix.cc`                         | Stable updater manifest origin |

## Publish flow

```bash
# Full release from a freshly built matrix; set the COS credentials in the environment.
FLOWIX_SKIP_BUILD=1 \
FLOWIX_TARGETS="aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc x86_64-unknown-linux-gnu" \
FLOWIX_PUBLISH=1 \
bash scripts/release.sh
```

```bash
# Partial release — only Windows (e.g. when macOS is held back).
FLOWIX_SKIP_BUILD=1 \
FLOWIX_TARGETS="x86_64-pc-windows-msvc" \
FLOWIX_PUBLISH=1 \
bash scripts/release.sh
```

Both flows upload packages to COS and the per-group manifest to the matching
stable R2 path, so the in-app updater picks up the new version immediately.
macOS releases also deploy the website's download links through flowix-home.

For macOS, the updater artifact is the Tauri `.app.tar.gz` archive; the DMG is
published separately for website downloads. For Windows, the updater artifact
is the Tauri NSIS `*-setup.exe`. Both updater artifacts have adjacent `.sig`
files and are installed by `tauri-plugin-updater`; the Windows NSIS package
continues to use its `/UPDATE` replacement flow.

Production Flowix builds require `TAURI_SIGNING_PRIVATE_KEY` (and optionally
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). `FLOWIX_ALLOW_UNSIGNED=1` is reserved
for local builds and disables updater artifact generation.

## Windows installation coordination

Windows updates use Tauri's `passive` mode: the user sees installation progress
without stepping through the setup wizard. The app saves documents and stops
its background work before handing the verified package to Tauri. The NSIS
adapter normalizes Tauri's executable path and delegates process/file checks
to `flowix-installer-helper`. Desktop shutdown, owned CLI cleanup and file-lock
waiting share one deadline; system API and filesystem enumeration overhead is
not a hard real-time guarantee. Other applications are never force-closed.

The app and installer share `FlowixData/app-update-state.json`. It records a
schema version, attempt UUID, target version, status and optional error. Writes
are atomic, with a cross-process lock around state transitions. The app passes
the UUID as `/FLOWIXATTEMPT=<uuid>` to NSIS; callbacks with another UUID or target
version cannot complete the current attempt. `/UPDATE`, rather than silent UI
mode, identifies updater installs. Manual successful installs clear stale state.

The helper imports the old target/result markers and writes the old result file
only for a legacy-client attempt, so a failed upgrade is still reported by the
old app. Keep this bridge and the old-directory migration while clients using
those protocols are supported. Remove them together only after the minimum
supported updater client no longer creates those markers.

`VerifiedUpdate` owns the update metadata and immutable verified bytes. Its
private constructor performs signature verification; its consuming `install`
method is the only installation entry point in this flow. Downloads and
completed partial files retain the verified buffer instead of immediately
reading and verifying it again. Only path/metadata are retained between UI
commands, so installation reloads and verifies the disk cache. The pinned
updater's `install` method does not perform
the download method's signature check, so the cache verification must remain.

The private helper CLI has separate `prepare`, `close-cli`, `record-update` and
`clear-update` subcommands. Process operations use `--target`; result operations
use `--state-dir`. Each command validates its own required options, statuses and
positive durations. The old permissive `--mode` parser is removed. Installer
hooks and the helper must be packaged together; older distributed installers
already contain their own helper, while their update-state protocol remains
supported by the compatibility bridge above.

NSIS uses `FLOWIX_RUN_HELPER` for all operations. It extracts the packaged helper
once per installer process, invokes the subcommand, and records failures in one
place. The preflight adapter alone handles interactive retry/abort behavior.

Windows production builds run `scripts/verify-windows-installer-preflight.mjs`
after packaging. It runs the real hook and helper in an isolated directory,
covering full paths with spaces, quiet/passive result callbacks, UTF-16 error
handoff and manual-install state cleanup. It does not install the product or change file associations. For local
checks, `FLOWIX_INSTALLER_HELPER` can point to a freshly built debug helper.

```powershell
cargo test --manifest-path app/Cargo.toml -p flowix-installer-helper
```

## Verifying a manifest locally

`scripts/verify-updater-release.mjs` validates a single manifest against the
artifacts on disk:

```bash
node scripts/verify-updater-release.mjs \
  --release-dir "$RELEASE_OUT" \
  "$RELEASE_OUT/updater/macos/latest.json" \
  "$VERSION" "v$VERSION" \
  darwin-aarch64 darwin-x86_64
```

`--release-dir` defaults to the manifest's parent directory, but per-group
manifests live under `updater/<group>/` while artifacts are staged at the
top level of `$RELEASE_OUT`, so the override is required in this flow.
