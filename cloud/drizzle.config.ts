import { defineConfig } from "drizzle-kit";

// 仅用于 schema.ts 的类型对齐与未来 drizzle-kit generate 生成增量 migration。
// 当前 routes 用原生 D1 SQL(见 src/routes/*);初始建表用 migrations/0001_init.sql。
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
