-- Initial schema for the product update notices control plane.
--
-- One table backing `supabase/functions/product-update-notices/index.ts`,
-- which the Flowix desktop client polls on startup to surface an in-app
-- "new version" pill in the status bar.
--
-- Reads happen server-side via the service role key (Edge Function env),
-- so the table is locked down with row-level security + no permissive
-- policies. The anon key shipped in the desktop binary cannot read rows.

create table if not exists public.product_update_notices (
  id            text        primary key,
  enabled       boolean     not null default true,
  title         text        not null,
  body          text        not null,
  version       text,
  platforms     text[]      not null default '{}',
  cta_label     text,
  cta_mac_url   text,
  cta_win_url   text,
  published_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

alter table public.product_update_notices enable row level security;

create index if not exists product_update_notices_lookup_idx
  on public.product_update_notices (enabled, published_at desc);
