// 客户端(Rust)与服务端(TS)共享的 API 契约。
// 协议漂移防护:客户端应据此实现等价的 serde 类型(见 cloud/README.md「协议共享」)。
import { z } from "zod";

// --- 计划与配额 ---
export const PLAN = { FREE: "free", PRO: "pro" } as const;
export type Plan = (typeof PLAN)[keyof typeof PLAN];

export const QUOTA_BYTES: Record<Plan, number> = {
  free: 500 * 1024 * 1024, // 500 MB
  pro: 1024 * 1024 * 1024, // 1 GB
};

export const INTERVAL = { MONTH: "month", YEAR: "year" } as const;
export type Interval = (typeof INTERVAL)[keyof typeof INTERVAL];

// --- memo id 校验:与客户端 MEMO_ID_ALPHABET [0-9a-z] 一致(6 或 8 位) ---
export const memoIdSchema = z
  .string()
  .regex(/^[0-9a-z]+$/)
  .refine((s) => s.length === 6 || s.length === 8, "memo id must be 6 or 8 chars");

// --- 单条 memo 变更(上行) ---
export const MemoChangeSchema = z.object({
  id: memoIdSchema,
  notebook_id: z.string().min(1),
  filename: z.string().min(1),
  content_hash: z.string().nullable(), // sha256(body);null = 无正文(纯元数据/删除)
  size_bytes: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(), // epoch ms
  deleted: z.boolean(),
  base_revision: z.number().int().nonnegative(), // 客户端上次拉到的该 memo revision(乐观锁)
  content_b64: z.string().optional(), // 小文件内联 base64;缺失表示仅元数据变更
});
export type MemoChange = z.infer<typeof MemoChangeSchema>;

export const PushRequestSchema = z.object({
  device_id: z.string().min(1),
  changes: z.array(MemoChangeSchema).max(500), // 单次最多 500 条,防滥用
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

// per-memo push 结果
export type PushItemResult =
  | { id: string; status: "accepted"; revision: number }
  | { id: string; status: "conflict"; server_revision: number; server_hash: string | null }
  | { id: string; status: "quota_exceeded" };

export interface PushResponse {
  results: PushItemResult[];
  used_bytes: number;
  quota_bytes: number;
}

export const PullRequestSchema = z.object({
  device_id: z.string().min(1),
  since: z.number().int().nonnegative(),
  notebooks: z.array(z.string()).optional(), // 不传 = 所有 sync_enabled 笔记本
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export interface PullItem {
  id: string;
  notebook_id: string;
  filename: string;
  content_hash: string | null;
  size_bytes: number;
  revision: number;
  updated_at: number;
  deleted: boolean;
  content_b64?: string; // 内联正文(笔记通常很小);大附件留 TODO: 走单独 GET
}

export interface PullResponse {
  changes: PullItem[];
  latest_revision: number;
}
