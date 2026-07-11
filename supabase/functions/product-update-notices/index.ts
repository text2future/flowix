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

type ParsedVersion = {
  numbers: number[];
  pre: (number | string)[];
  build: string[];
};

// Strict semver-ish parser: tolerates a leading "v" and surrounding whitespace,
// splits build metadata ("+…") from pre-release ("-…"), and coerces only fully
// numeric segments — anything else stays as a string so the pre-release compare
// can decide ordering. Per the semver spec, build metadata is dropped before
// comparison.
function parseVersion(raw: string): ParsedVersion {
  const head = raw.trim().replace(/^v/i, "");
  const plusIndex = head.indexOf("+");
  const numericPart = plusIndex === -1 ? head : head.slice(0, plusIndex);
  const buildPart = plusIndex === -1 ? "" : head.slice(plusIndex + 1);
  const dashIndex = numericPart.indexOf("-");
  const core = dashIndex === -1 ? numericPart : numericPart.slice(0, dashIndex);
  const prePart = dashIndex === -1 ? "" : numericPart.slice(dashIndex + 1);

  const numbers = core.length === 0
    ? [0]
    : core.split(".").map((segment) => {
      const parsed = Number.parseInt(segment, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });

  const pre = prePart.length === 0
    ? []
    : prePart.split(".").map((segment) =>
      /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment
    );

  const build = buildPart.length === 0
    ? []
    : buildPart.split(".").filter((segment) => segment.length > 0);

  return { numbers, pre, build };
}

// Semver: numeric identifiers sort before alphanumeric ones; within the same
// kind, numeric/string compare normally.
function comparePreId(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "string") return -1;
  if (typeof a === "string" && typeof b === "number") return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareSemver(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  const len = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < len; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff;
  }

  // Per semver: a release outranks the same numeric core with a pre-release
  // tag (e.g. 1.2.3 > 1.2.3-rc.1).
  if (left.pre.length === 0 && right.pre.length > 0) return 1;
  if (left.pre.length > 0 && right.pre.length === 0) return -1;
  if (left.pre.length === 0 && right.pre.length === 0) return 0;

  const preLen = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < preLen; index += 1) {
    if (index >= left.pre.length) return -1;
    if (index >= right.pre.length) return 1;
    const diff = comparePreId(left.pre[index]!, right.pre[index]!);
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
