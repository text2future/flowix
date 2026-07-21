import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { applyMigrations, signup, login } from "./helpers";

const BASE = "http://localhost";

describe("auth", () => {
  beforeAll(applyMigrations);

  it("signup -> login -> refresh", async () => {
    const r1 = await signup("alice@example.com", "dev-alice");
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(b1.access_token).toBeTruthy();
    expect(b1.refresh_token).toBeTruthy();

    const r2 = await login("alice@example.com", "dev-alice");
    expect(r2.status).toBe(200);

    const r3 = await SELF.fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: b1.refresh_token }),
    });
    expect(r3.status).toBe(200);
    const b3 = (await r3.json()) as { access_token: string };
    expect(b3.access_token).toBeTruthy();
  });

  it("duplicate email -> 409", async () => {
    await signup("bob@example.com", "dev-bob");
    const r = await signup("bob@example.com", "dev-bob-2");
    expect(r.status).toBe(409);
  });

  it("wrong password -> 401", async () => {
    const r = await login("bob@example.com", "dev-bob", "wrong-password");
    expect(r.status).toBe(401);
  });

  it("refresh with rotated(old) token -> 401", async () => {
    const r1 = await signup("rotate@example.com", "dev-rotate");
    const b1 = (await r1.json()) as { refresh_token: string };
    const r2 = await SELF.fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: b1.refresh_token }),
    });
    expect(r2.status).toBe(200);
    // 旧 token 已吊销,再用 -> 401
    const r3 = await SELF.fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: b1.refresh_token }),
    });
    expect(r3.status).toBe(401);
  });

  it("rejects 11th device", async () => {
    const r0 = await signup("carol@example.com", "dev-carol-0");
    expect(r0.status).toBe(201);
    // signup 已 1 设备;再登 9 个新设备 = 10;第 11 个拒绝
    for (let i = 1; i <= 9; i++) {
      const r = await login("carol@example.com", `dev-carol-${i}`);
      expect(r.status).toBe(200);
    }
    const r11 = await login("carol@example.com", "dev-carol-11");
    expect(r11.status).toBe(403);
  }, 30000);
});
