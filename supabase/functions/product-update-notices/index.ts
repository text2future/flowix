import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type NoticeRow = {
  id: string;
  title: string;
  body: string;
  version: string | null;
  platforms: string[];
  cta_mac_url: string | null;
  cta_win_url: string | null;
  published_at: string;
};

function normalizeList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).toLowerCase()).filter(Boolean)
    : [];
}

function listAllows(list: string[], value: string): boolean {
  return list.length === 0 || list.includes(value.toLowerCase());
}

function compareSemver(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let index = 0; index < len; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// A row whose `version` is set targets a release the client must still be
// behind; rows without `version` are version-agnostic and always delivered.
function isTargetedAtClient(row: NoticeRow, clientVersion: string): boolean {
  if (!row.version) return true;
  return compareSemver(clientVersion, row.version) < 0;
}

// Resolve which CTA column to expose for the requesting platform.
// Unknown OS values return null — we don't fall back across platforms to
// avoid silently sending a mac link to a win client (or vice versa).
function ctaUrlForOs(row: NoticeRow, os: string): string | null {
  if (os === "macos") return row.cta_mac_url;
  if (os === "windows") return row.cta_win_url;
  return null;
}

function toClientNotice(row: NoticeRow, os: string) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    version: row.version,
    ctaLabel: row.cta_label,
    ctaUrl: ctaUrlForOs(row, os),
    publishedAt: row.published_at,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const version = url.searchParams.get("version") ?? "";
  const os = (url.searchParams.get("os") ?? "").toLowerCase();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "missing_supabase_env" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase
    .from("product_update_notices")
    .select("*")
    .eq("enabled", true)
    .lte("published_at", new Date().toISOString())
    .order("published_at", { ascending: false })
    .limit(25);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const notice = ((data ?? []) as NoticeRow[]).find((row) => {
    return (
      listAllows(normalizeList(row.platforms), os)
      && isTargetedAtClient(row, version)
    );
  });

  return new Response(
    JSON.stringify({ notice: notice ? toClientNotice(notice, os) : null }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
