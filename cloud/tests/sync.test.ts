import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrations,
  b64,
  signupToken,
  putNotebook,
  pushMemo,
  pull,
} from "./helpers";

describe("sync", () => {
  beforeAll(applyMigrations);

  it("push new memo -> rev 1, update -> rev 2", async () => {
    const token = await signupToken("sync1@example.com", "dev-sync1");
    await putNotebook(token, "nb_a", "Test");

    const r1 = await pushMemo(token, "dev-sync1", "nb_a", {
      id: "abc12345",
      base_revision: 0,
      content_b64: b64("hello"),
      updated_at: 1000,
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { results: { status: string; revision: number }[] };
    expect(b1.results[0]).toMatchObject({ status: "accepted", revision: 1 });

    const r2 = await pushMemo(token, "dev-sync1", "nb_a", {
      id: "abc12345",
      base_revision: 1,
      content_b64: b64("world"),
      updated_at: 2000,
    });
    const b2 = (await r2.json()) as { results: { status: string; revision: number }[] };
    expect(b2.results[0]).toMatchObject({ status: "accepted", revision: 2 });
  });

  it("stale base_revision -> conflict", async () => {
    const token = await signupToken("sync2@example.com", "dev-sync2");
    await putNotebook(token, "nb_b", "Test");

    await pushMemo(token, "dev-sync2", "nb_b", {
      id: "conf0001",
      base_revision: 0,
      content_b64: b64("a"),
      updated_at: 1000,
    });
    // base_revision=0 已过期(服务端 rev1)-> conflict
    const r = await pushMemo(token, "dev-sync2", "nb_b", {
      id: "conf0001",
      base_revision: 0,
      content_b64: b64("b"),
      updated_at: 2000,
    });
    const b = (await r.json()) as {
      results: { status: string; server_revision: number }[];
    };
    expect(b.results[0]).toMatchObject({ status: "conflict", server_revision: 1 });
  });

  it("over quota -> quota_exceeded", async () => {
    const token = await signupToken("sync3@example.com", "dev-sync3");
    await putNotebook(token, "nb_c", "Test");
    // 把配额压到极小
    const acct = await env.DB.prepare("SELECT id FROM accounts WHERE email = ?")
      .bind("sync3@example.com")
      .first<{ id: string }>();
    await env.DB.prepare("UPDATE accounts SET quota_bytes = 10 WHERE id = ?")
      .bind(acct.id)
      .run();

    const r = await pushMemo(token, "dev-sync3", "nb_c", {
      id: "quota001",
      base_revision: 0,
      content_b64: b64("x".repeat(100)),
      updated_at: 1000,
    });
    const b = (await r.json()) as { results: { status: string }[] };
    expect(b.results[0].status).toBe("quota_exceeded");
  });

  it("pull returns memos with inline content", async () => {
    const token = await signupToken("sync4@example.com", "dev-sync4");
    await putNotebook(token, "nb_d", "Test");
    await pushMemo(token, "dev-sync4", "nb_d", {
      id: "pull0001",
      base_revision: 0,
      content_b64: b64("hi"),
      updated_at: 1000,
    });

    const r = await pull(token, "dev-sync4", 0);
    const b = (await r.json()) as {
      changes: { id: string; content_b64?: string; revision: number }[];
      latest_revision: number;
    };
    expect(b.changes.length).toBe(1);
    expect(b.changes[0].id).toBe("pull0001");
    expect(b.changes[0].content_b64).toBeTruthy();
    expect(b.changes[0].revision).toBe(1);
    expect(b.latest_revision).toBe(1);
  });

  it("disabled notebook is excluded from pull", async () => {
    const token = await signupToken("sync5@example.com", "dev-sync5");
    await putNotebook(token, "nb_e", "Test", false); // sync_enabled=false
    await pushMemo(token, "dev-sync5", "nb_e", {
      id: "disab001",
      base_revision: 0,
      content_b64: b64("x"),
      updated_at: 1000,
    });
    // push 对 disabled notebook 返回 conflict(notebook 校验失败)
    const pr = (await (await pushMemo(token, "dev-sync5", "nb_e", {
      id: "disab002",
      base_revision: 0,
      content_b64: b64("y"),
      updated_at: 2000,
    })).json()) as { results: { status: string }[] };
    expect(pr.results[0].status).toBe("conflict");

    const r = await pull(token, "dev-sync5", 0);
    const b = (await r.json()) as { changes: unknown[] };
    expect(b.changes.length).toBe(0);
  });
});
