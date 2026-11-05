# 文档关系索引：当前实施方案

2026-11-04。通用 Obsidian 风格文档引用，不含业务状态、内容编号、图谱或 HTML 页面。

## 存储

每个笔记本继续使用 `.flowix/notebook.db`，复用 `notes` 与 `note_index_meta`，新增两张可重建的投影表：

- `note_links`：source_path、syntax、link_kind、target_kind、target_key、lookup_key、reference_count。按来源/语法/类型/目标聚合重复引用，WITHOUT ROWID；目标查找键建立复合索引。
- `note_link_state`：source_path、indexed_content_hash、parser_version、dirty、request_id、last_error、retry_after。每个来源一条，同时承担持久待处理队列；仅 dirty 行建立调度索引。

来源外键连接 `notes.relative_path`，删除和路径更新级联。目标不设外键，不保存重复反向边，不持久化目标解析结果。已有 notes 增加按 filename_lower、relative_path 查找的索引；Windows 另建 relative_path COLLATE NOCASE 索引以支持 ASCII 路径大小写匹配，其他平台沿用大小写敏感主键；原文件名排序索引以收藏字段开头，不作为简名查找的唯一索引。

`note_index_meta` 保存独立的 links_schema_version、links_parser_version。当前关系 schema/parser 版本均为 2；旧解析投影会按持久队列重新处理，不依赖正文再次编辑。request_id 是一次待处理任务的令牌，不是文档身份。文档身份仍为笔记本和相对路径。

## 迁移与保存路径

关系 schema 以短事务增量创建，不替换 notebook.db。已有文档一次性回填待处理状态。普通连接沿用现有 schema 快路径，只读检查关系表、索引、触发器与版本；完整 DDL、回填不会每次执行。

文档插入、content_hash 真实变化时，由 SQLite 触发器在原事务内标记 dirty、更新任务令牌、清除错误退避。路径变化由触发器清除已处理哈希并重新排队，即使正文哈希不变也重算相对链接。文件删除通过来源外键清理对应出链与状态，其他来源指向该文件的引用保留。

保存函数不解析链接、不遍历其他文档、不等待后台。成功更新文档投影后，保存小型正文快照供后台复用。快照单份不超过 256KiB，总量不超过 8MiB / 64 份，按来源合并并淘汰；缓存丢失不影响恢复。

新增的后台准入仅使用进程内状态：保存期间让路，笔记本最近一次变更后等待约 500ms 空闲。正在持续保存时延期，不追着每次自动保存解析。CLI 等其他进程仍通过同一数据库触发器持久标脏；跨进程写竞争继续由现有结构锁和 SQLite 管理。

## 后台处理

桌面端使用一个独立后台 worker，按笔记本合并唤醒，初次文档对账完成后启动对应关系处理。单批默认 8 篇，批间让出；暂停、恢复和停止跟随原维护生命周期。

1. 从 pending 部分索引选取到期来源。
2. 优先取匹配内容哈希的保存快照；否则有界读取该篇文件并校验哈希。
3. 在 SQLite 写事务外执行 Markdown 解析、规范化及引用聚合。
4. 遵循现有锁顺序取得结构共享锁，短事务内再次确认当前哈希、request_id 和解析器版本。
5. 已有链接集合相同则不重写链接表；变化时仅替换该来源的链接。
6. 同事务更新处理状态，提交成功后才报告完成。

正文变化、删除后同路径重建、路径移动等会改变任务令牌；旧结果不能覆盖新任务。写锁忙时让出，后台不在取得 SQLite 写锁后再等待外层结构锁。解析或文件读取失败时保留上次成功结果，标记错误并退避；下一次内容变化自动清除退避。应用重启后由 dirty 行恢复，广播只用于唤醒。

整批在文档间检查约 25ms 时间预算；单篇输入还设上限：4MiB 正文、50,000 次引用、4,096 个去重引用记录。超限不发布部分结果，保留旧投影并记录错误。预算不是单篇执行耗时的硬实时保证。

## 链接语义

- CommonMark 行内、引用式链接通过 pulldown-cmark 事件提取；代码块、行内代码及 HTML 示例区域不产生 Wiki 假链接。
- Wiki 支持 `[[文档]]`、`[[目录/文档]]`、别名显示、标题/块引用和嵌入。标题、块片段当前聚合至文档，暂不验证锚点存在性。
- Markdown 相对路径按来源目录计算；Wiki 带目录路径按笔记本根定位，明确的 `./`、`../` 按来源目录定位。
- Wiki 简名依次匹配同目录、根目录、笔记本内唯一文件名候选；多候选返回 ambiguous。该版本明确采用此顺序，不宣称覆盖 Obsidian 的全部边缘行为。
- 支持 `.md`、`.markdown`，保留 UTF-8 路径、百分号编码及标题分隔语义。Wiki 中的 `?` 按文件名字符保留，Markdown URL 仍剥离查询参数。Windows 明确路径采用 SQLite NOCASE 的 ASCII 大小写规则，非 ASCII 字符仍要求原始拼写；Wiki 全局简名继续使用 Unicode 小写键。不会逐链接访问文件系统。
- Flowix 当前笔记本深链接（b/f、旧参数与当前根下的物理 path）兼容接入。第一版不解析跨笔记本关系。
- 常见图片、音视频、PDF 等附件与外部网址不进入文档引用表。不建立业务编号、主题相似或无链接提及关系。
- 通用文档索引原本排除 `.agents` 等点前缀目录，本次保持该范围。

## 查询

core 提供：

- `query_note_outlinks(notebook_id, source_path, cursor, limit)`
- `query_note_backlinks(notebook_id, target_path, cursor, limit)`
- `note_link_status(notebook_id)`
- `process_note_links_background_batch(...)`：遵守保存优先和空闲窗口。
- `process_note_links_batch(...)`：显式维护，可直接执行有限批次。

查询不对账、不读正文，只在短只读快照内查数据库。每页最多 200 条候选；明确路径和简名按复合索引筛选，明确路径匹配分批使用 IN 查询；Wiki 全局简名按去重后的文件名批量执行索引范围查询，每个文件名最多取两个候选即可判定唯一或歧义，不再聚合全部同名行，不逐引用调用 SQL/IPC。

反链查询拆为四个目标等值范围，每个范围沿现有目标索引及其隐含主键顺序读取，先应用游标并最多取 limit+1 条，再合并排序、关联来源状态。每页至多合并 804 条候选，避免先读取全部入链再排序；无需新增索引或修改保存写入。

反链分页会过滤歧义或实际指向其他路径的候选，所以允许空结果页仍携带 nextCursor。调用者必须按 hasMore/nextCursor 继续，不依赖条数判断结束。游标绑定笔记本、路径及方向。多页查询是实时 keyset 分页，不维持跨请求的长 SQLite 快照。

链接返回 resolved_path、resolution 和 fresh。resolution 为 resolved / missing / ambiguous / index-pending。fresh=false 表示来源尚待更新或上次解析失败，结果来自最近成功投影；出链页提供 sourceFresh，空结果可区分“已处理且零引用”和“尚未处理”；反链涉及多个来源，该字段为 null。pending 统计包含退避中的失败任务，failed 单独提供其数量。

目标新增、删除、同名候选变化后，下一次查询直接使用当前 notes 判断，不需要扫描或重写来源正文。目标文档本身仍依赖原有文档索引及时更新。

桌面只读命令为 list_note_links 和 get_note_link_status，类型化客户端入口为 notes.links 和 notes.linkStatus。命令会请求后台维护，不等待维护完成。未增加任何图谱页面或 HTML 数据桥权限。

## 验证与性能解释

自动测试覆盖解析/代码边界、CRLF frontmatter、带点文件名、畸形 Wiki 输入与单行 50,000 个有效 Wiki 链接、四类反链候选混合分页、重复计数、仅标脏保存、快照复用、目标新增/删除、同名歧义、出反链分页、源移动与目录移动、旧结果与同路径重建竞态、异常恢复及 schema/parser 升级保护。

性能探针使用临时数据库，10,000 条已索引文档、100 条出链，并将查询、解析和真实保存分开测量：

```sh
cargo test -p flowix-core report_relation_index_performance --manifest-path app/Cargo.toml -- --ignored --nocapture --test-threads=1
```

本机 debug 测量中，100 条出链热查询 P95 约 4ms，反链约 2ms。该数据使用索引行构造大库，不能代表首次读取一万篇正文的构建速度。

保存探针对比无操作触发器、真实 dirty 触发器，以及后台 worker 运行三种场景；快照缓存和 schema 检查在对照组中都存在，因此仅能隔离触发器和后台竞争成本，不能作为全部新增代码相对旧版本的精确回归率。初次持续抢占测试暴露保存尾延迟增加，因而增加了前台准入及空闲窗口。后续运行仍有 fsync/WAL checkpoint 和环境噪声造成的尾部波动；不据此承诺零影响或 P95 回归已稳定小于 5%。

高入度探针使用应用实际链接的 SQLite，在临时数据库中构造入链，并对比原始 SQL 与优化后的完整查询接口：

```sh
cargo test -p flowix-core report_high_degree_backlink_performance --manifest-path app/Cargo.toml -- --ignored --nocapture --test-threads=1
```

本机 debug 构建，每组运行 12 次，取中位数：

| 入链数 | 原 SQL | 优化后完整查询接口 |
| --- | --- | --- |
| 1,000 | 4.224 ms | 8.649 ms |
| 10,000 | 32.795 ms | 7.141 ms |
| 100,000 | 663.652 ms | 13.637 ms |

原查询计划出现 `USE TEMP B-TREE FOR ORDER BY`。两列测量范围不同：新接口还包含连接、状态读取和目标解析，结果用于观察高入度下的增长趋势；小数据量下拆分查询有额外固定开销。这些合成数据不代表真实笔记本的完整性能。

Wiki 扫描缓存当前行的结束位置，避免每个有效链接重复扫描整行剩余部分；单行 50,000 个重复链接的解析在本次 debug 测量中约为 348 ms。该耗时包含 Markdown 解析和引用聚合，不代表后台单篇处理能严格限制在 25 ms 内。

要证明正式性能目标，还需在固定硬件、release 构建、相同真实 Vault 数据集下进行完整前后对照及首次构建/高入度文档测量。
