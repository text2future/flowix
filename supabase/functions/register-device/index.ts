// Flowix 桌面端"首次启动设备登记" Edge Function。
//
// 客户端 (Rust / Tauri) 在首次启动 10s 后 POST 过来一条本机指纹:
//   { deviceId, machineId?, machineFingerprint, hostnameHash?,
//     os, arch, appVersion, locale?, timezone?, installedAt, appUserAgent? }
//
// 服务端用 service_role 写 `device_registrations` 表, upsert by device_id:
//   - 新设备: insert, 返回 firstSeen=true
//   - 已登记设备: refresh last_seen_at / app_version / locale / timezone
//                 (installed_at 保留原始时间), firstSeen=false
//
// 网络层语义与现有 `product-update-notices` 完全一致, anon key 通过 header
// 传, 真正写入用 service_role 绕 RLS。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface IncomingPayload {
  deviceId?: unknown;
  machineId?: unknown;
  machineFingerprint?: unknown;
  hostnameHash?: unknown;
  os?: unknown;
  arch?: unknown;
  appVersion?: unknown;
  locale?: unknown;
  timezone?: unknown;
  installedAt?: unknown;
  appUserAgent?: unknown;
}

function asString(v: unknown, max = 256): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function asOptString(v: unknown, max = 256): string | null {
  return asString(v, max);
}

function asUuid(v: unknown): string | null {
  const s = asString(v, 64);
  if (!s) return null;
  // 最简 uuid 校验, 详细规则由 PG unique constraint 兜底。
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return null;
  }
  return s.toLowerCase();
}

function asIsoTime(v: unknown): string | null {
  const s = asString(v, 64);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "missing_supabase_env" }, 500);
  }

  let body: IncomingPayload;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "invalid_json", detail: String(err) }, 400);
  }

  const deviceId = asUuid(body.deviceId);
  const machineFingerprint = asString(body.machineFingerprint, 64);
  const os = asString(body.os, 32);
  const arch = asString(body.arch, 32);
  const appVersion = asString(body.appVersion, 32);
  const installedAt = asIsoTime(body.installedAt);

  if (!deviceId) return jsonResponse({ error: "invalid_deviceId" }, 400);
  if (!machineFingerprint) {
    return jsonResponse({ error: "invalid_machineFingerprint" }, 400);
  }
  if (!os) return jsonResponse({ error: "invalid_os" }, 400);
  if (!arch) return jsonResponse({ error: "invalid_arch" }, 400);
  if (!appVersion) return jsonResponse({ error: "invalid_appVersion" }, 400);
  if (!installedAt) return jsonResponse({ error: "invalid_installedAt" }, 400);

  const machineId = asOptString(body.machineId, 256);
  const hostnameHash = asOptString(body.hostnameHash, 64);
  const locale = asOptString(body.locale, 64);
  const timezone = asOptString(body.timezone, 64);
  const appUserAgent = asOptString(body.appUserAgent, 256);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // 先查这行是否存在, 决定 firstSeen ── 比 `returning` 的 raw 数据多读一次,
  // 但语义最清晰。
  const { data: existing } = await supabase
    .from("device_registrations")
    .select("id")
    .eq("device_id", deviceId)
    .maybeSingle();

  const upsertPayload = {
    device_id: deviceId,
    machine_id: machineId,
    machine_fingerprint: machineFingerprint,
    hostname_hash: hostnameHash,
    os,
    arch,
    app_version: appVersion,
    locale,
    timezone,
    installed_at: installedAt,
    last_seen_at: new Date().toISOString(),
    app_user_agent: appUserAgent,
  };

  const { data, error } = await supabase
    .from("device_registrations")
    .upsert(upsertPayload, { onConflict: "device_id" })
    .select("id")
    .single();

  if (error || !data) {
    return jsonResponse(
      { error: "db_error", detail: error?.message ?? "unknown" },
      500
    );
  }

  return jsonResponse({
    rowId: data.id,
    firstSeen: !existing,
  });
});
