create table if not exists public.product_update_notices (
  id text primary key,
  enabled boolean not null default true,
  kind text not null default 'upgrade' check (kind in ('upgrade', 'announcement', 'critical')),
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

alter table public.product_update_notices enable row level security;

drop policy if exists "Public can read enabled product update notices"
  on public.product_update_notices;

create policy "Public can read enabled product update notices"
  on public.product_update_notices
  for select
  using (
    enabled = true
    and published_at <= now()
    and (expires_at is null or expires_at > now())
  );

create index if not exists product_update_notices_lookup_idx
  on public.product_update_notices (enabled, channel, priority desc, published_at desc);
