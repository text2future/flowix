// Drizzle schema,与 migrations/0001_init.sql 对齐。
// 用途:类型对齐 + 未来 drizzle-kit generate 生成增量 migration。
// 当前 routes 用原生 D1 SQL 保证可读性;生产可逐步切到 drizzle 查询。
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  email: text("email").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  plan: text("plan").notNull().default("free"),
  quotaBytes: integer("quota_bytes").notNull().default(524288000),
  usedBytes: integer("used_bytes").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name"),
  platform: text("platform"),
  appVersion: text("app_version"),
  lastSeenAt: integer("last_seen_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revoked: integer("revoked").notNull().default(0),
  rotatedFrom: text("rotated_from"),
  createdAt: integer("created_at").notNull(),
});

export const notebooks = sqliteTable("notebooks", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  icon: text("icon"),
  sort: integer("sort").notNull().default(0),
  syncEnabled: integer("sync_enabled").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const memos = sqliteTable(
  "memos",
  {
    accountId: text("account_id").notNull(),
    id: text("id").notNull(),
    notebookId: text("notebook_id").notNull(),
    filename: text("filename").notNull(),
    contentHash: text("content_hash"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at").notNull(),
    deleted: integer("deleted").notNull().default(0),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.accountId, t.id] }) })
);

export const deviceCursors = sqliteTable("device_cursors", {
  deviceId: text("device_id").primaryKey(),
  accountId: text("account_id").notNull(),
  lastPullRevision: integer("last_pull_revision").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const subscriptions = sqliteTable("subscriptions", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  plan: text("plan").notNull(),
  interval: text("interval"),
  status: text("status").notNull(),
  currentPeriodEnd: integer("current_period_end"),
  cancelAtPeriodEnd: integer("cancel_at_period_end").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),
  processedAt: integer("processed_at").notNull(),
});

export const syncLog = sqliteTable("sync_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: text("account_id").notNull(),
  deviceId: text("device_id"),
  action: text("action").notNull(),
  detail: text("detail"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});
