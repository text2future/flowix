# Flowix Cloud

Flowix 云端同步服务端。**Cloudflare Workers + D1 + R2 + KV**,支付走 **Stripe**。

这是 Flowix 主仓库里的独立子项目(`app/` 是 Rust 桌面端,`cloud/` 是 TS 服务端),技术栈、构建、部署完全独立。

## 技术栈

| 职责 | 选型 |
|---|---|
| Web 框架 | **Hono** |
| 元数据库 | **D1**(SQLite):账户/设备/memo 索引/订阅/配额/审计 |
| 正文/附件存储 | **R2**(零出口流量费) |
| 缓存/限流 | **KV**:refresh 黑名单、rate-limit 计数 |
| ORM | **Drizzle**(schema 对齐 + 迁移生成;routes 当前用原生 D1 SQL) |
| 校验 | **Zod** |
| JWT | **jose**(RS256) |
| 密码哈希 | **@noble/hashes**(scrypt) |
| 支付 | **stripe** |
| 防机器人 | **Cloudflare Turnstile** |

## 目录结构

```
cloud/
├── wrangler.jsonc          # Worker 配置 + D1/R2/KV binding + Cron
├── package.json · tsconfig.json · drizzle.config.ts
├── .dev.vars.example       # 本地 secrets 模板
├── migrations/
│   ├── 0001_init.sql       # 初始建表(8 表 + 索引,幂等)
│   └── 0002_audit_log.sql  # 审计日志表
└── src/
    ├── index.ts            # Hono 入口 + cors + onError + scheduled(Cron GC)
    ├── env.ts              # Bindings/Variables 类型
    ├── protocol.ts         # ★ 客户端共享的 API 契约
    ├── db/{schema,index}.ts
    ├── lib/
    │   ├── crypto.ts       # scrypt + JWT RS256 + refresh token
    │   ├── id.ts
    │   ├── errors.ts       # HttpError + 统一 error envelope
    │   ├── turnstile.ts    # Turnstile siteverify
    │   ├── audit.ts        # sync_log 审计
    │   └── gc.ts           # tombstone GC(清 R2 + 回收配额)
    ├── middleware/
    │   ├── auth.ts         # JWT 验证 -> 注入 account_id
    │   └── rateLimit.ts    # KV 计数器限流
    └── routes/
        ├── health.ts       # /health + /health/deep(D1/R2 探活)
        ├── auth.ts         # signup/login/refresh/logout(限流+Turnstile+设备上限)
        ├── account.ts      # profile/quota/devices
        ├── notebooks.ts    # 选择性同步开关
        ├── sync.ts         # push/pull/ack(冲突检测+真实配额+审计)
        ├── billing.ts      # Stripe checkout/portal
        ├── webhook.ts      # Stripe webhook(验签+幂等+状态机)
        └── internal.ts     # /internal/gc 手动触发
```

## 前置

- Node 18+
- Cloudflare 账号,`npx wrangler login` 登录
- Stripe 账号(测试模式即可)

## 1. 安装

```bash
cd cloud && npm install
```

## 2. 创建 Cloudflare 资源(把返回的 id 填进 `wrangler.jsonc`)

```bash
npx wrangler d1 create flowix-cloud       # database_id
npx wrangler r2 bucket create flowix-memos
npx wrangler kv namespace create KV       # id
```

## 3. 配置本地 secrets

```bash
# JWT RS256 密钥对
openssl genpkey -algorithm RSA -out jwt.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in jwt.pem -pubout -out jwt.pub.pem

cp .dev.vars.example .dev.vars
# 编辑 .dev.vars:
#   JWT_PRIVATE_KEY / JWT_PUBLIC_KEY  <- PEM 内容
#   STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
#   TURNSTILE_SECRET_KEY  <- 本地可留空跳过;生产必填
#   GC_SECRET             <- 任意强随机串
```

线上用 `wrangler secret put <NAME>` 注入同名变量。

## 4. 数据库迁移

```bash
npm run db:migrate:local     # 本地(miniflare)
# 远程:npm run db:migrate:remote
```

## 5. Stripe 配置

1. Dashboard 建 **Pro 产品** + **monthly / yearly 两个 price**,把 `price_...` 填进 `wrangler.jsonc` 的 `STRIPE_PRICE_PRO_MONTH` / `STRIPE_PRICE_PRO_YEAR`。
2. webhook endpoint -> `https://<worker>.workers.dev/webhooks/stripe`,事件:`checkout.session.completed`、`invoice.paid`、`customer.subscription.updated`、`customer.subscription.deleted`。
3. 本地转发:`stripe listen --forward-to localhost:8787/webhooks/stripe`。

## 6. 本地开发

```bash
npm run dev          # wrangler dev -> http://localhost:8787
curl http://localhost:8787/health
curl http://localhost:8787/health/deep
```

## 7. 部署

```bash
for s in JWT_PRIVATE_KEY JWT_PUBLIC_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET TURNSTILE_SECRET_KEY GC_SECRET; do
  npx wrangler secret put $s
done
npm run db:migrate:remote
npm run deploy
```

## 运维:GC 与限流

- **tombstone GC**:删除的 memo 保留 30 天(tombstone,供离线设备补同步),之后由 **Cron 每 6 小时**自动清理--物理删 D1 行 + 删 R2 所有 revision 对象 + 按 account 回收 `used_bytes`。也可手动触发:
  ```bash
  curl -X POST -H "x-internal-secret: $GC_SECRET" https://<worker>/internal/gc
  ```
- **限流**(KV 计数器):注册 10 次/小时/IP、登录 10 次/10 分钟/IP。`/sync/*` 可按需追加 `rateLimit`。
- **审计**:`sync_log` 记 push/pull/billing/gc 摘要,供配额追溯与安全审计(可定期 TTL 清理)。

## 测试 / CI / 环境分离

- **单元测试**:`npm test`(vitest 4 + `@cloudflare/vitest-pool-workers`,本地 miniflare 模拟 D1/R2/KV)。覆盖 `/health`、auth(signup/login/refresh rotation/重复 email/错密码/设备上限)、sync(push 新建+更新、conflict、quota_exceeded、pull 内联正文、disabled notebook 排除)。测试用 RSA 密钥进程级生成,Turnstile/限流自动跳过。
- **CI**:`.github/workflows/cloud.yml`,`cloud/**` 路径触发:typecheck + test;`main` 分支自动 `wrangler deploy --env production`(需仓库 `CLOUDFLARE_API_TOKEN` secret)。D1 迁移不自动跑,手动 `npm run db:migrate:remote`。
- **环境分离**:`wrangler.jsonc` 默认环境 = 本地 dev(miniflare,占位 id 可用);`env.production` = 生产(独立 D1/R2/KV + prod 域名)。部署生产:`npx wrangler deploy --env production`;生产 secret 单独注入:`wrangler secret put X --env production`。

## API 概览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | - | 轻量健康检查 |
| GET | `/health/deep` | - | D1/R2 探活 |
| POST | `/auth/signup` | 限流+Turnstile | 注册(free,500MB) |
| POST | `/auth/login` | 限流 | 登录(设备上限 10) |
| POST | `/auth/refresh` | - | 刷新(rotation) |
| POST | `/auth/logout` | - | 吊销 refresh |
| GET | `/account` | Bearer | profile + plan + 配额 |
| GET | `/account/devices` | Bearer | 设备列表 |
| DELETE | `/account/devices/:id` | Bearer | 踢设备 |
| GET | `/notebooks` | Bearer | 笔记本列表(逻辑身份) |
| PUT | `/notebooks/:id` | Bearer | upsert(name/icon/sort/**sync_enabled**) |
| POST | `/sync/push` | Bearer | 上行(冲突检测 + 真实配额 + 审计) |
| POST | `/sync/pull` | Bearer | 下行(按 since + enabled 笔记本) |
| POST | `/sync/ack` | Bearer | 更新设备游标 |
| POST | `/billing/checkout` | Bearer | Stripe Checkout(month/year) |
| POST | `/billing/portal` | Bearer | Stripe Customer Portal |
| POST | `/webhooks/stripe` | 验签 | Stripe webhook(幂等) |
| POST | `/internal/gc` | x-internal-secret | 手动触发 GC |

## 协议共享(防漂移)

`src/protocol.ts` 是 single source of truth。客户端 Rust 用 `serde` 对齐,例如:

```rust
#[derive(Serialize, Deserialize)]
struct MemoChange {
    id: String,
    notebook_id: String,
    filename: String,
    content_hash: Option<String>,
    size_bytes: u64,
    updated_at: i64,            // epoch ms
    deleted: bool,
    base_revision: i64,         // 乐观锁
    content_b64: Option<String>,
}
```

建议用 JSON Schema codegen 或端到端测试防漂移。

## 安全要点

- **JWT RS256 15min** + refresh token rotation(30 天,旧 token 即吊销)
- **强制 account_id 隔离**:所有 D1/R2 操作带 `WHERE account_id = ?`,R2 key 带 `accounts/<id>/` 前缀
- **scrypt** 密码哈希(常量时间比较)
- **配额按实际字节**:push 时按 base64 解码后的真实长度计 `used_bytes`,不信客户端 `size_bytes`
- **Turnstile** 注册防机器人;**限流**登录防爆破;**设备上限** 10
- **Stripe webhook** 验签 + 按 event id 幂等
- **选择性同步**服务端按 `sync_enabled` 强制过滤
- **审计日志** `sync_log`;**统一 error envelope** `{error, message}`
- 后续(阶段4):E2EE、Durable Objects 实时推送

## 成本

- **Workers 付费版**($5/月)必需:scrypt CPU + D1 写次数 + Cron。
- **R2**:零出口流量费。
- **D1**:按行读写计费,`/sync/push` 已批量处理。

## 下一步:客户端集成

1. `flowix-core` 新增 `sync/` 模块:diff `~/.flowix/index.db` 的 `memos.updated_at` vs last_sync -> changeset -> 调本服务。
2. 复用现有:`device_id`(`device_registration.rs`)、`SecretStore`(存 token)、`atomic_write_bytes`、**`self_write` mark**(下行写回抑制 watcher 回响,关键)。
3. 新增 IPC:`sync_signup` / `sync_login` / `sync_status` / `sync_now` / `sync_set_notebook_enabled` 等,注册到 `app/flowix-desktop/src/app/bootstrap.rs`。
4. 前端「云同步」设置分区:账户、笔记本开关、配额进度、订阅管理。
