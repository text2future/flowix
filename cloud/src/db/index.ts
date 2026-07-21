import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

// drizzle 实例工厂。当前 routes 用原生 D1 SQL,此工厂预留给未来切换 drizzle 查询。
export function createDrizzle(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type DB = ReturnType<typeof createDrizzle>;
export { schema };
