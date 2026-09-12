---
key: d5t924hj
---

# DSH runtime release

DSH is released as a self-contained Node 24 runtime. Every target must be
built on that target architecture (the macOS x64 build runs under Rosetta on
Apple Silicon), then packaged and smoke-tested from the final tarball.

The required checks are now part of the commands:

```bash
npm run dsh:build:prod:macos
npm run dsh:package:prod
```

The package step checks the exact `koffi` optional dependency version, the
actual `.node` Mach-O/ELF/PE architecture, direct native-addon loading, and
the full `initialize → thread/start → thread/close → shutdown` stdio flow.

Publish only after both platform archives are present:

```bash
FLOWIX_DSH_RELEASE_DIR=.build/releases/dsh \
FLOWIX_DSH_CHANNEL=macos \
npm run dsh:publish
```

`dsh:publish` validates local checksums/signatures, uploads immutable
`dsh/<version>/` objects first, downloads them back through the public URLs,
and updates `dsh/<channel>/latest.json` only after those checks pass. It then
downloads and compares the stable manifest, so a failed upload cannot advance
the client-facing version pointer.
