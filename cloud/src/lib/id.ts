// 通用工具。Workers 运行时提供 crypto.randomUUID() 与 Date.now()。
export function uuid(): string {
  return crypto.randomUUID();
}
export function nowMs(): number {
  return Date.now();
}

// refresh token 有效期 30 天(ms)
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
