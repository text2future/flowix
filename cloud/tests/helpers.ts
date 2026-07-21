import { env, SELF } from "cloudflare:test";
// ?raw: vite 打包时把 SQL 内联为字符串,避开 worker isolate 的文件路径问题
import migration1 from "../migrations/0001_init.sql?raw";
import migration2 from "../migrations/0002_audit_log.sql?raw";

const BASE = "http://localhost";
const MIGRATION_SQL = (migration1 as string) + "\n" + (migration2 as string);

// 应用所有 migration(幂等,IF NOT EXISTS)
// 去掉 -- 注释(行首/行内)再按 ; 拆分逐条 prepare:D1 exec 对含注释的语句会报错
export async function applyMigrations(): Promise<void> {
  const stripped = MIGRATION_SQL.split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
  for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
}

export function b64(s: string): string {
  return btoa(s);
}

export async function signup(email: string, deviceId: string, password = "password123"): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, device_id: deviceId }),
  });
}

export async function signupToken(email: string, deviceId: string): Promise<string> {
  const r = await signup(email, deviceId);
  if (!r.ok) throw new Error(`signup failed: ${r.status}`);
  const b = (await r.json()) as { access_token: string };
  return b.access_token;
}

export async function login(email: string, deviceId: string, password = "password123"): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, device_id: deviceId }),
  });
}

export async function putNotebook(token: string, id: string, name: string, syncEnabled = true): Promise<void> {
  const r = await SELF.fetch(`${BASE}/notebooks/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, sync_enabled: syncEnabled }),
  });
  if (!r.ok) throw new Error(`putNotebook failed: ${r.status}`);
}

export interface PushChange {
  id: string;
  base_revision: number;
  content_b64?: string;
  updated_at: number;
  deleted?: boolean;
}

export async function pushMemo(token: string, deviceId: string, nbId: string, change: PushChange): Promise<Response> {
  const size = change.content_b64 ? atob(change.content_b64).length : 0;
  return SELF.fetch(`${BASE}/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      device_id: deviceId,
      changes: [
        {
          id: change.id,
          notebook_id: nbId,
          filename: "note.md",
          content_hash: "h_" + change.id,
          size_bytes: size,
          updated_at: change.updated_at,
          deleted: change.deleted ?? false,
          base_revision: change.base_revision,
          content_b64: change.content_b64,
        },
      ],
    }),
  });
}

export async function pull(token: string, deviceId: string, since: number): Promise<Response> {
  return SELF.fetch(`${BASE}/sync/pull`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, since }),
  });
}
