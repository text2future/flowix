# Supabase Product Update Notices

Flowix uses Supabase as a remote copy and rollout control plane for in-app
upgrade notices. Supabase does not install updates. The actual download,
signature verification, and binary replacement are handled by
`tauri-plugin-updater` (wired in `[app/flowix-desktop/src/lib.rs]`).

## How the in-app update flow works

```
                Supabase (announcements)
                         │
                         ▼   product_update_notices row
   ┌─────────────────────────────────────────────────────────────┐
   │ status-bar pill discovers:  "is there an announcement for me?" │
   │   └─ fetch /functions/v1/product-update-notices?version=…   │
   │       response carries { ctaUrl } (per platform)            │
   └─────────────────────────────────────────────────────────────┘
                         │   user clicks pill
                         ▼
            ┌─────────────────────────────────┐
            │  tauri-plugin-updater runs       │
            │   1. check() the release manifest│  ── signer pubkey baked into binary
            │   2. downloadAndInstall()       │  ── privkey kept by build pipeline
            │   3. relaunch()                  │
            └─────────────────────────────────┘
                         │
                         ▼
                desktop app reborn on the new version
```

The Supabase layer is a **notice** ("look, there's a newer version").
It does **not** point at the artifact directly — the `ctaUrl` fields are
carried for legacy browser-click scenarios but the status-bar pill routes
through `tauri-plugin-updater` for the actual install.

## Signer keys

Generate one with `npx tauri signer generate -w ~/.tauri/keys/<name>.key`.
Paste the resulting public key into `[app/flowix-desktop/tauri.conf.json]`
`plugins.updater.pubkey`. Keep the private key out of the repo; pass it to
the build environment as:

- `TAURI_SIGNING_PRIVATE_KEY` (string) or `TAURI_SIGNING_PRIVATE_KEY_PATH`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (only if your key has one)

Without a private key in the build env, `tauri build` will not produce signed
update artifacts and the desktop app's updater check will see nothing.

## dev vs prod updater config

`tauri.conf.json` (prod): `plugins.updater.active = true`, endpoints point at
the GitHub release `/update.json`. The browser-style fallback in `ctaUrl`
remains in the row for hand-offs.

`tauri.conf.dev.json`: `plugins.updater.active = false`, `endpoints: []`.
Reason: dev shouldn't repeatedly hit a real release endpoint on every
restart. The pill still discovers via Supabase (which has no relevance in
dev either, but is harmless).

## Runtime contract

Configure the desktop app with:

- `FLOWIX_PRODUCT_UPDATES_URL`: Supabase Edge Function URL.
- `FLOWIX_SUPABASE_ANON_KEY`: optional anon key when the function requires it.

Current project configuration:

```powershell
$env:FLOWIX_PRODUCT_UPDATES_URL="https://fqvruyesgivjlwhojyya.supabase.co/functions/v1/product-update-notices"
$env:FLOWIX_SUPABASE_ANON_KEY="sb_publishable_l6AmH0K0Uq8_roThQHSnnQ_2xxxl0o1"
```

Use the same environment variables in CI/release builds so Rust can embed the
fallback values at compile time. The app also reads them at runtime for local
development.

The desktop app calls the function with query parameters:

- `version`: current Flowix version.
- `os`: Rust `std::env::consts::OS`.
- `arch`: Rust `std::env::consts::ARCH`.
- `channel`: currently `stable`.
- `language`: UI language.
- `region`: stored install region.

The Edge Function may return either:

```json
{
  "notice": {
    "id": "notice-2026-07-10",
    "kind": "upgrade",
    "title": "Flowix 0.9.1 is available",
    "body": "This release improves product update checks and notebook stability.",
    "version": "0.9.1",
    "ctaLabel": "Download update",
    "ctaUrl": "https://example.com/releases/flowix-0.9.1",
    "dismissible": true,
    "remindAfterHours": 24,
    "publishedAt": "2026-07-10T00:00:00Z"
  }
}
```

or a raw notice object. Return `204 No Content`, `null`, or `{ "notice": null }`
when no notice should be shown.

## Table

```sql
create table product_update_notices (
  id text primary key,
  enabled boolean not null default true,
  kind text not null default 'upgrade',
  title text not null,
  body text not null,
  version text,
  min_app_version text,
  max_app_version text,
  channel text not null default 'stable',
  platforms text[] not null default '{}',
  languages text[] not null default '{}',
  regions text[] not null default '{}',
  cta_label text,
  cta_url text,
  dismissible boolean not null default true,
  remind_after_hours integer,
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  priority integer not null default 0,
  created_at timestamptz not null default now()
);
```

Use the Edge Function to filter by platform, language, region, channel,
publish window, version range, and priority. Keep service role keys only in
Supabase function secrets, never in the desktop client.

## Deploy

```bash
supabase link --project-ref fqvruyesgivjlwhojyya
supabase db push
supabase functions deploy product-update-notices
```

The Edge Function uses Supabase-managed `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` function secrets. Do not put the service role key
in the desktop app.
