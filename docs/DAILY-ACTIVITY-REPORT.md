# 桌面端「日活跃」上报（Windows / macOS）

> 一句话：**本地 04:00 为界，跨过就报一次；报之前先在本地算清楚，不跨日不发请求。**
> 覆盖"产品开着过夜、隔天继续用也不重启"这个场景，改动只在客户端。

---

## 1. 现状为什么不行

| 事实 | 位置 |
|---|---|
| 设备登记只在启动后 10s 发一次 `POST /functions/v1/register-device` | 原 `device_registration.rs::spawn_startup_registration`（已删） |
| payload 原本只有 `deviceId / os / arch / appVersion / installedAt`，没有时间信息 | `DevicePayload` |
| 没有任何跨日/唤醒/焦点监听 | 全仓库无 `NSWorkspace`、`GetLastInputInfo` |
| 登录续期与云同步都打 `cloud.flowix.cc`，与 Supabase 无关 | `flowix-sync/src/client.rs`、`commands/cloud/coordinator.rs` |

结论：进程不重启就不会再上报，第二天没有任何记录。

---

## 2. 规则

```
活跃日 key = (Local::now() - 4h).format("%Y-%m-%d")
判定       = key != 本地已报过的 key
```

- **本地时间 04:00 为界**。`2026-11-07 03:59` → `2026-11-06`；`04:00` → `2026-11-07`。
- 选 04:00 而不是 00:00：熬夜到凌晨的用户不该被拆成两天。
- 用本地时区而不是固定时区：规则直观；改时区最多让某一天提前/延后，不影响"每天至多一条"。

---

## 3. 客户端行为

```
启动 ──10s 错峰──> 报一次(trigger=launch)
         │
         └─> 每 15s：本地算 day key
                  ├─ 等于已报过的 ──> 什么都不做（0 请求、0 日志）
                  └─ 不等于 ──────> 报一次(trigger=rollover)
```

四件事保证可靠：

1. **先本地判定再打接口**。每 15s 只做一次 `Local::now()` 和一次字符串比较；没跨日连
   `reqwest::Client` 都不构造。所以"频繁"只发生在本地，接口一天至多几次。
2. **15s 周期，不用「定时到 04:00」**。单调时钟基于 `mach_absolute_time`（macOS）/
   QPC（Windows），深度睡眠期间都不前进 —— `sleep_until(次日 04:00)` 合盖一整晚后会在
   唤醒时再睡满一整晚。分片 + 墙钟读，才能保证"跨过 4 点后重新激活窗口 ≤15s 补报"。
3. **失败按梯度重试**：30s → 1m → 5m → 10m → 15m（封顶）。退避计时用 `Instant`
   （单调），不受用户改系统时间影响；退避只在同一天生效，换日立即重试。
4. **本地不落盘待报队列**。重复上报由服务端 `(device_id, activity_day)` 幂等收敛，
   进程重启后重发同一天也不会多出一行。

### 代码结构

`daily_activity::DayState` 是纯状态机（只回答「要不要发」，不碰 IO）；`run()` 只负责
调 `DeviceRegistry::report()` 和 sleep。跨日、退避、trigger 的转移全部可单测。
`device_registration` 只持有线上协议（payload 形状）和一次 HTTP 调用，不含调度逻辑；
`spawn()` 用 `Once` 保证全进程只有一条循环，也就是 `boot.json` 的唯一写者。

已知边界（刻意接受）：判定依据是"应用在跑"，不是"人在用"。机器整夜开着没人碰，第二天
仍会记一条。要收紧到"真实输入"就得接系统空闲时长（mac `CGEventSourceSecondsSinceLastEventType`
/ win `GetLastInputInfo`），按当前需求不值得。

---

## 4. 请求

复用现有 `register-device`，payload 追加一个可选对象；`activity` 为 `None` 时字段整体省略，
**payload 与旧版逐键同形**，老 edge function 不受影响。

```jsonc
{
  "deviceId": "uuid",
  "os": "macos",
  "arch": "aarch64",
  "appVersion": "1.4.2",
  "installedAt": "2026-10-01T08:00:00Z",
  "activity": {
    "clientDay": "2026-11-07",   // 客户端按本地 04:00 算出的日 key
    "trigger": "rollover"        // launch | rollover
  }
}
```

幂等键 `(device_id, activity_day)`。客户端重发、补报、多设备同日都收敛成一行。
单次请求超时沿用 8s，失败不影响 UI，也不阻塞启动链。

---

## 5. 服务端（待做，独立仓库）

```sql
create table if not exists public.device_activity (
  device_id         uuid        not null references public.devices(id) on delete cascade,
  activity_day      date        not null,
  first_reported_at timestamptz not null default now(),
  last_reported_at  timestamptz not null default now(),
  report_count      int         not null default 1,
  os                text,
  app_version       text,
  primary key (device_id, activity_day)
);
create index if not exists device_activity_day_idx on public.device_activity (activity_day);
```

edge function 三行关键逻辑：

```ts
// 1) 设备 upsert 照旧，顺带刷新 last_seen_at
// 2) 有 activity 就写日活（同一天重复上报只加计数）
//    ON CONFLICT (device_id, activity_day) DO UPDATE
//      SET report_count = device_activity.report_count + 1,
//          last_reported_at = now(),
//          os = excluded.os, app_version = excluded.app_version
// 3) 日 key 用客户端传入的值；若要防篡改，可与服务端算的 UTC+8 04:00 日 key 比对，
//    偏差超过 1 天时只记入独立列、不覆盖 activity_day
```

查询：

```sql
-- DAU
select activity_day, count(*) from public.device_activity group by 1 order by 1 desc limit 90;
-- MAU
select count(distinct device_id) from public.device_activity
where activity_day >= current_date - 29;
```

`devices.last_seen_at` 仍是"最近一次启动"，与 `device_activity` 语义不同，别混用。

---

## 6. 验收

| 场景 | 期望 |
|---|---|
| 开着过夜，跨过 04:00 | ≤15s 内出现当天一行（`trigger=rollover`） |
| 跨过 04:00 时窗口最小化，之后重新激活 | 激活后 ≤15s 内补上（判定不看可见性） |
| 一天里反复启动 10 次 | 仍只有 1 行（幂等 upsert） |
| 同一天再检查 500 次 | 0 次网络请求（本地判定拦掉） |
| 04:00 那刻断网，10 分钟后恢复 | 退避重试补上，不缺当天 |
| 整天关机 | 无行（正确语义） |
| 用户把系统时间改成明天 | 会多一个未来日 key，改回后当天再报一次；服务端按日幂等，仍是 1 行（仅 `report_count` 增加）。要防篡改需服务端按自己的时钟归日 |
| 升级到带该字段的版本 | 旧 `boot.json` 不受影响（本次未改 schema） |

日志（`~/.flowix/logs/app.log`）：

- `activity.report.ok`：`day=... trigger=...`
- `activity.report.failed`：`day=... trigger=... failures=N error=...`
- 判定为"今天已报过"时不写任何日志（常态一天 5760 次，写 debug 也是刷屏）。

---

## 7. 改动清单

| 文件 | 内容 |
|---|---|
| `src/daily_activity.rs`（新增） | 日 key、`DayState` 状态机、15s 循环、失败退避、单测 |
| `src/device_registration.rs` | payload 追加可选 `activity`；`try_register_once` → `report(Option<ActivityPayload>)`；删掉 `spawn_startup_registration` 与启动延迟常量（调度统一归 `daily_activity`） |
| `src/app/bootstrap.rs` | `spawn_startup_registration()` → `daily_activity::spawn(device_registry.clone())` |
| `src/lib.rs` | 挂上 `mod daily_activity;` |

无新增 crate；`BOOT_SCHEMA_VERSION` 保持 2（改它会让 `device_id` 重置）。
职责边界：调度 / 状态在 `daily_activity`，线上协议 / HTTP 在 `device_registration`。

---

## 8. 明确不做

- 不接系统空闲/锁屏判定：口径是"应用在跑即当天活跃"，够用且零平台相关代码。
- 不落盘待报队列、不做服务端校时：幂等 upsert 已保证重复无害，队列只增加状态面。
- 不做分钟级心跳、不做常驻服务、不采集 hostname/locale/时区。
- 不用云同步轮询充当活跃信号：同步可关闭、可未登录，语义也不同。
