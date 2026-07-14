-- 设备登记表 ── 桌面应用首次启动异步上报的本机指纹。
-- 仅 Edge Function (service_role) 写入, anon 默认 deny。
-- 入站字段: device_id (uuid, 客户端 UUID v4, 一台机器稳定唯一),
-- machine_id (跨 reinstall 用, 来自 machine-uid crate),
-- os / arch / app_version / locale / timezone。
-- 不落原始 hostname, 只落 hostname 的 FNV-1a 64-bit 16hex 摘要。

create table if not exists public.device_registrations (
  id                   uuid primary key default gen_random_uuid(),
  device_id            uuid        not null unique,
  machine_id           text        null,
  machine_fingerprint  text        not null,
  hostname_hash        text        null,
  os                   text        not null,
  arch                 text        not null,
  app_version          text        not null,
  locale               text        null,
  timezone             text        null,
  installed_at         timestamptz not null,
  registered_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  app_user_agent       text        null,
  raw_meta             jsonb       not null default '{}'::jsonb
);

create index if not exists device_registrations_last_seen_idx
  on public.device_registrations (last_seen_at desc);

create index if not exists device_registrations_app_version_idx
  on public.device_registrations (app_version);

create index if not exists device_registrations_machine_id_idx
  on public.device_registrations (machine_id)
  where machine_id is not null;

alter table public.device_registrations enable row level security;

-- Edge Function 用 service_role key 写入, 绕过 RLS, 不需要显式 policy。
-- anon / authenticated 默认全部拒绝 (RLS on + no policy = deny)。
