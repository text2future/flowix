# Contributing to Flowix

## Branch naming

`<type>/<short-kebab-summary>`. One branch = one logical change. Reuse
existing history first; don't open a new branch on top of an unrelated WIP
that you haven't picked up.

| Type        | When                                              | Example                           |
| ----------- | ------------------------------------------------- | --------------------------------- |
| `feat/`     | new feature visible to users                      | `feat/updater-status-pill`        |
| `fix/`      | bug                                              | `fix/memo-search-tokenizer-crash`  |
| `refactor/` | internal change with no user-visible behaviour    | `refactor/extract-skill-loader`   |
| `perf/`     | non-observable perf hot path                      | `perf/memo-index-query-cache`     |
| `chore/`    | tooling / deps / infra                           | `chore/bump-tauri-2.4`           |
| `docs/`     | docs only                                        | `docs/architecture-decision-0010` |
| `test/`     | test-only change                                 | `test/cli-sidecar-fixtures`       |

Cut short summaries (≤ 5 words). Avoid names that age badly (`fix-bug2`).

## Commit messages

Subject line ≤ 72 chars, imperative mood, no trailing period.

```
<scope>: <one-line summary>

Optional body explaining WHY. Wrap at 72 columns. Reference the issue
or PR with `#123`. Don't repeat what the diff says.
```

Common `<scope>` values used in this repo: `updater`, `dialog`, `cli`,
`docs`, `theme`, `memo`, `agent`, `i18n`, `status-bar`.

Squash local noise before pushing. A PR with `wip`, `tmp`, `fix typo`
commits is harder to read than one with three structured commits.

## Pull requests

- Push the branch, open a PR against `main` (`#feat/...` is fine, just not
  `main` itself until approved).
- CI must be green before merge.
- At least one approval; if you don't have a reviewer available, mark the
  PR `draft:` and tag `@flowix/reviewers` once ready.
- Don't `force-push` after review: it makes re-review painful. Use
  `git commit --fixup` and `git rebase --autosquash` if you must rebase.

### PR template

`.github/PULL_REQUEST_TEMPLATE.md` is what review comments attach to. Fill
its `## What` + `## Why` + `## How tested` sections even for "trivial"
changes — it's how reviewers skip what they don't need to read.

## Releases

- `main` is the source of truth; every release is a tag on `main`.
- Tag format: `v<semver>` (e.g. `v1.0.3`).
- Tag → push → `.github/workflows/release.yml` builds the artifacts and
  publishes the GitHub release. Don't publish by hand.
- Hot-fix → `v1.0.4` patch release from a `fix/...` branch merged into
  `main`; never from a fork.
- Draft releases are fine; flip to public after artifacts are uploaded.

## Local workflow

```bash
git fetch origin
git switch -c feat/some-thing origin/main
# ... do work ...
git add -p        # stage hunks, not whole files
git commit -m "updater: ..."
git push -u origin feat/some-thing
gh pr create --base main
```

`git push` rules: never `git push --force` to `main` / `feat/*` if anyone
else may have branched off it; use `--force-with-lease` to detect drift.
If a branch is fully stale (no risk of conflict), just delete it with
`git push origin :feat/some-thing`.

## Secrets

- Never commit `.env`, signing keys, OAuth tokens, or `~/.tauri/keys/*`.
  `.gitignore` already guards the common spots.
- For local dev, use `export FLOWIX_*` and friends; never `git add` them.
- For CI, route through repository secrets
  (`Settings → Secrets and variables → Actions`).

## Code style

- Rust: `rustfmt` defaults; clippy is friend not foe. The PR bot runs
  `cargo fmt --check` and `cargo clippy -- -D warnings`.
- TypeScript / TSX: prettier + eslint (see `package.json`).
- Comments in source-of-truth files (security model, migrations, RLS
  policies) deserve real prose. Inline nitpicks live in commit messages
  and PR threads, not in the source.
