## What

<!-- One paragraph: what changed and why now. -->

## Why

<!-- The user-visible or system-level motivation. Reference any issue #NNN. -->

## How tested

<!-- Be specific: which commands run, which screenshots, which record_event
     lines you tail'd. "I ran cargo check" is not enough for non-trivial
     changes. -->

- [ ] `cargo test --workspace`
- [ ] `cargo fmt --check`
- [ ] `cargo clippy --workspace -- -D warnings`
- [ ] `npm run lint`
- [ ] Manual verification: <what you clicked, what you saw, in which OS>

## Risks

<!-- Anything that could break in unexpected ways. Rollout plan if relevant. -->

## Checklist

- [ ] No secrets / tokens / `.env` files touched
- [ ] No force-push to `main`
- [ ] If interface change: CHANGELOG / docs updated
- [ ] If schema change: migration added + reversible
