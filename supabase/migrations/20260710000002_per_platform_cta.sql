-- Per-platform CTA URLs: rename the generic cta_url to cta_mac_url
-- (preserving existing rows' values) and add a cta_win_url for Windows
-- clients. The Edge Function resolves which column to expose based on the
-- client's `os` query param.

alter table public.product_update_notices rename column cta_url to cta_mac_url;

alter table public.product_update_notices
  add column cta_win_url text;
