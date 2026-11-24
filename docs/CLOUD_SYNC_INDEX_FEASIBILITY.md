# 笔记云存储能否去掉云端数据库索引

> **历史调研，不是当前实现规范。** 本文讨论的是保留服务端冲突裁决和索引语义的方案，未纳入后来选定的 path-keyed LWW 设计。当前上线范围与实现状态以 [`CLOUD_STORAGE_PATH_LWW_DESIGN.md`](CLOUD_STORAGE_PATH_LWW_DESIGN.md) 和 [`CLOUD_STORAGE_RELEASE_PLAN.md`](CLOUD_STORAGE_RELEASE_PLAN.md) 为准；本文保留为决策背景，避免把旧结论当成当前路线。

调研对象：`flowix-cloud`（`src/infra/user-state/*`：`schema/queries/durable-object/blobs/maintenance`、`src/api/routes/v2/sync-routes.ts`、`src/domain/sync-protocol.ts`）＋ `flowix-main` 客户端（`app/flowix-sync/src/{v2,store/v2,manager/v2_engine*}`、`app/flowix-desktop/src/commands/cloud/coordinator.rs`）。
外部约束依据：Cloudflare R2 定价/限制/一致性文档、Durable Objects 定价/限制文档（2026-11 读取）。
**未做压测**：文中成本是按下述单价算出的量级估算，标注了假设。

---

## 0. 结论

**内容字节可以不走索引，同步不行。** 三句话分层：

| 场景 | 能否无索引 | 说明 |
|---|---|---|
| 云备份 / 整本恢复（单端上传、另一端一次性取回） | **可以** | R2 键即路径，末尾写一份 manifest 收尾；不需要变更流、墓碑、冲突裁决 |
| 多端增量同步（现状 protocol epoch 3） | **不可以** | 墓碑、单调变更序号、冲突基线、路径唯一性、配额与在飞预留、操作幂等，六件事都需要服务端有一个串行裁决点 |
| 去掉 DO SQL、把索引搬到对象存储（manifest + CAS） | **技术上可以，但不省钱也不省复杂度** | 换介质不等于去掉索引；代价变成 O(N) 全量传输、单 key 1 写/秒、失去原子批量与唯一约束 |

最容易被忽略的一点：客户端本地**已经有同构索引**（`v2_note_states` 存 `revision / content_hash / filename / deleted / last_seq`）。云端这份不是"多存了一份副本"，而是**唯一的仲裁者**。去掉它不等于少存数据，而是取消裁决点——冲突只能退回 last-writer-wins。

---

## 1. 现状：索引里到底有什么，去掉后谁负责

| 表 | 承担的不变式 | 去掉后 | 观察 |
|---|---|---|---|
| `notes` | 路径 → 当前 head（hash/blob/size/revision/last_seq/deleted） | 无替身 | 客户端能算出"本地有什么"，但算不出"云端这份是新是旧" |
| `notebooks` | 笔记本元数据 + head；删除时用 `MAX(notes.last_seq) > baseTreeSeq` 拒绝竞态 | 无替身 | 需要子项最大序号，list 拿不到 |
| `state` | `head_seq`、`usage_bytes`、`note_count`、`quota_bytes` | 只能 list+sum | 计费口径必须强一致 |
| `uploads` | `pending/verified/active/retired/deleting` 状态机 + 对象 key；24h 延迟回收与失败重试 | R2 生命周期能按前缀删，但删不掉"未被引用"判断 | 正在上传 / 已被新版本取代，两种 orphan 语义不同 |
| `operations` | 30 天操作回执（同 operationId 返回原结果、换 payload 报 `OPERATION_ID_REUSED`） | 一操作一对象 + `If-None-Match` | 100 条 push 从 1 次 DO 请求变成 100 次 Class A 写 |

逐条对照协议时，有六件事是**对象存储原语表达不了**的：

1. **路径唯一性**：`idx_notes_live_path_key` 是 `(notebook_id, path_key)` 的 UNIQUE，`path_key = NFC + lower`。R2 的键区分大小写，`A.md` 与 `a.md` 是两个对象，两个设备并发创建"同名"文件时没有任何原子手段判定冲突。
2. **墓碑**：`deleted = 1` 永久保留。没有它，一台离线设备无法区分"云端删了"和"我本地有但还没传"，bootstrap 会把已删文件重新上传。这是无索引方案里最先崩的地方。
3. **变更流**：`changes?cursor=` 依赖 `last_seq` 单调递增。R2 没有"自 T 以来哪些键变了"的原语，`ListObjects` 只有全量；R2 Event Notifications 是至少一次、无序、要走 Queue，不能当客户端同步游标。
4. **冲突基线**：`baseRevision` 必须与服务端当前 head 精确相等。改到对象存储可以借 `If-Match/ETag`，但 ETag 绑的是"对象键"：改名后基线丢失，跨路径移动、笔记本级删除都退回人工判断。
5. **移动谱系**：`note.move` 一次事务里写源墓碑 + 目标 head（连续两个 seq），客户端 `find_v2_relocated_note` 靠 `moved_from_id + sync_seq` 沿链回溯处理 A→B→A。没有服务器序列，移动就只能当"删一个建一个"。
6. **配额与在飞预留**：`reserveBlob` 要把 `usage_bytes + 在飞 pending/verified 的 SUM + 本次` 与 quota 比。这条是防"付费账号反复预留大附件把对象堆满"的补丁（代码注释里写明了事故）。对象存储侧只能 list 求和，O(N) 且与写入竞态。

---

## 2. 平台硬约束（官方文档，2026-11）

| 项 | 数值 | 对方案的影响 |
|---|---|---|
| R2 同一对象键并发写 | **1 次/秒** | manifest / 日志尾部这类"热键"设计的天花板 |
| R2 条件写 | `If-Match`/`If-None-Match` 原子、同 key 串行化；412 仍计 Class A | CAS 可行，但冲突放大成本 |
| R2 一致性 | 读写删与 **list 均强一致** | 全量 list 的正确性没问题，问题在成本与延迟 |
| R2 单价 | Class A $4.50/M（含 List/Put）、Class B $0.36/M（Get/Head）、删除免费 | 全量 list 是主要成本项 |
| DO SQLite 单对象 | 10 GB、单行 2 MB、软限 ~1000 req/s | 索引空间不是瓶颈（2 MB / 5000 篇） |
| DO 计费 | 请求 $0.15/M、行读 $0.001/M、行写 $1.00/M、存储 $0.20/GB-month | 索引**便宜到可以忽略** |

按 5000 篇、单客户端 30s 轮询（`coordinator.rs::CLOUD_POLL_INTERVAL`）、每天活跃 8 小时估算：

| 方案 | 每月平台成本/用户 | 备注 |
|---|---|---|
| 现状：增量拉取 + DO 索引 | **≈ $0.03–0.05** | 28,800 次请求 $0.004 + 约 2.4 万行写 $0.024 + 2 MB 存储 |
| 方案 A：路径即键 + 全量 list | **≈ $1.94** | 5 次 list/轮询 × 28,800 = 43.2 万 Class A；1000 篇时约 $0.39 |
| 方案 B：单份 manifest + CAS | ≈ $0.05–0.10 | 钱的差别小，但在"1 写/秒/键"和整份读写上 |

会员价 $29/年 ≈ $2.4/月。方案 A 的操作费就吃掉约 80% 收入——**"用 list 代替增量"才是真正贵的部分，索引本身不是成本问题**。所以"去掉索引为了省钱"这条动机不成立。

---

## 3. 四个候选方案的实际可行性

**A. 路径即键 + list 对账**
`users/{uid}/notebooks/{nb}/{path}`，写入直接 PUT（可带 `If-Match`），拉取靠 `ListObjects` 全量对账。
- 优点：服务端零状态，代码量最省（客户端可砍掉 bootstrap/changes/push/move 与幂等回执，约为现状 1/3）。
- 否决项：成本见上表；无墓碑 → 删/增不可判；rename 丢 ETag 基线；大小写路径变两个对象；无原子批量；无配额。
- 适用：只读发布、单端备份。

**B. 每笔记本一份 manifest 对象 + CAS**
`files[path] = {hash, size, rev, deleted}` + 笔记本元数据，写用 `If-Match`，412 重读重试。
- 优点：墓碑、路径唯一性、清单内自洽都能表达；能省掉 SQL 迁移与 epoch 重置。
- 否决项：同 key **1 写/秒**，初次大同步 5 批 push 会与 412 重试互相踩；每次写读+写整份清单（5000 篇≈600 KB，1 万篇≈1.2 MB），轮询也要整份下载（现状增量页通常几百字节）；412 计费。
- 判断：**它就是一个索引，只是从 SQLite 搬到了 R2**。省下的是 DDL 与运维，付出的是并发上限与带宽。

**C. 追加式操作日志 + 定期压实**
每用户一个零填充 seq 前缀，`If-None-Match: *` 抢号，客户端 replay，定期压实成 manifest。
- 逻辑上能替代 `changes`，但日志无限增长、抢号留空洞、压实要 cron 遍历用户（又需要一份用户清单状态）。复杂度不低于现状，收益只是"不用 SQL"。

**D. 换数据库（D1 每用户一库 / KV）**
KV 最终一致（约 60s），做不了 revision 校验；D1 每用户一库仍是"索引"，还失去 DO 对单用户的天然串行化。属于换实现，不是去索引。

---

## 4. 如果目标是降复杂度：可以真做的三处裁剪（保留索引）

1. **blob 键改内容寻址**：`blobs/{sha256}` 取代 `blobs/{随机 blobId}`。同内容跨文件/跨版本共享，move 天然零拷贝，少一层 `blob_id → 内容` 映射；代价是删除要引用计数（`uploads.note_id` 扩成引用表）。
2. **`operations` 表 TTL 缩短或移除**：每次 push 多一行写，30 天回执的收益只覆盖"响应丢失后重试"。降到 1–3 天可省写放大；注意 move 重试会从"返还原结果"退化为 `PATH_CONFLICT`。
3. **把 orphan 回收交给 R2 生命周期 + 一次引用扫描**：`pending/` 前缀按 1 天过期可省掉一半状态机；但"active 但无人引用"仍需索引，核心省不掉。

不建议动的：`notebooks` 并入 `notes`（笔记本删除的 `baseTreeSeq` 依赖子项 `MAX(last_seq)`）、墓碑清理（bootstrap 正确性依赖）。

---

## 5. 建议

1. **多端同步维持现状的索引**，把它理解为"裁决器"而不是"缓存"。真要减负，走第 4 节的三处裁剪。
2. **如果产品愿意把"云备份"单独做成一个模式**（只上传 + 整本恢复，不做增量、不做冲突副本），那可以无索引，采用 A 的变体：本地扫描出差异 → 只传变更 → 末尾写一份 manifest。这是唯一能真正去掉索引且不牺牲正确性的产品切法。
3. **验证方式**（如果仍想推翻）：`wrangler dev` + 5000 篇 fixture，测两件事——(a) 串行（非并发）写同一 manifest 键是否也受 1 次/秒约束；(b) 600 KB manifest 在 30s 轮询下的 CPU 时长与 412 重试放大率。这两项决定 B 的可行性，其余结论不依赖它们。

---

## 6. 未验证项

- R2 文档措辞是 "maximum concurrent writes to the same object name: 1 per second"，串行写是否同样限速未实测。
- 方案 B 的 412 重试放大未压测，多设备同时同步的抖动无实测数据。
- 成本表按 8 小时/天活跃估算；若客户端 24h 常开，请求量约 3 倍，结论方向不变（方案 A 会更贵）。
