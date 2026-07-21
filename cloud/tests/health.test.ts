import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const BASE = "http://localhost";

describe("health", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET /health/deep probes D1 + R2", async () => {
    const res = await SELF.fetch(`${BASE}/health/deep`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: { d1: boolean; r2: boolean } };
    expect(body.checks.d1).toBe(true);
    expect(body.checks.r2).toBe(true);
  });
});
