-- Simplify product_update_notices: keep only fields needed for the
-- "client < target version → upgrade prompt" workflow. The RLS policy and
-- composite index reference dropped columns, so rebuild them without those
-- dependencies.

drop policy if exists "Public can read enabled product update notices"
  on public.product_update_notices;

drop index if exists public.product_update_notices_lookup_idx;

alter table public.product_update_notices
  drop column if exists kind,
  drop column if exists min_app_version,
  drop column if exists max_app_version,
  drop column if exists channel,
  drop column if exists languages,
  drop column if exists regions,
  drop column if exists dismissible,
  drop column if exists remind_after_hours,
  drop column if exists expires_at,
  drop column if exists priority;

create policy "Public can read enabled product update notices"
  on public.product_update_notices
  for select
  using (
    enabled = true
    and published_at <= now()
  );
