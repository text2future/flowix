# 云存储（路径型对象存储同步）架构评审

评审对象：`app/flowix-sync` + `app/flowix-desktop/src/commands/cloud`，约 18.1k 行 Rust（其中测试约 6k），187 个测试。
评审时间：2026-11-24。

## 一、结论

架构骨架达标，短板在工程执行层。**79 / 100（B+）**，不需要重做设计。

| 维度 | 得分 | 依据 |
|---|---|---|
| 分层与依赖方向 | 19 / 20 | 决策（`reconcile`）纯函数、无 I/O；传输（`object_store_ops`）、磁盘（`LocalStore`）、凭证（`CredentialResolver`）三个接口边界清晰 |
| 竞态与数据安全 | 18 / 20 | 「未知 ≠ 缺失」、同秒 ETag 兜底、先排队 stamp 再 PUT、mass-deletion 闸门 |
| 错误处理 | 11 / 15 | 分支齐全，但失败被压成字符串，不可编程（本次已修） |
| 性能与资源 | 12 / 20 | 每次语句重开连接、阻塞 I/O 跑在 worker、大附件全量缓冲 |
| 可维护性 | 12 / 15 | `v4` 命名已无信息量，`object_store.rs` 1292 行职责混杂 |
| 测试 | 7 / 10 | 决策层表格驱动测试很好；缺 pass 级故障注入 |

## 二、已经做对的部分（不要动）

| 设计 | 位置 | 为什么关键 |
|---|---|---|
| 纯函数决策层 | `reconcile.rs` | 服务端时钟作为入参，决策表可表格驱动测试 |
| 「未知不等于缺失」 | `reconcile.rs` `mark_unknown` + 列举完整性校验 | 500 或分页截断不会变成删除授权 |
| 同秒竞态用 ETag 兜底 | `reconcile.rs` `object_replaced` | `LastModified` 只有秒级精度 |
| 先排队 stamp 再 PUT | `v4_pass/execution.rs` | 崩溃在「服务端已写入、本地未记账」之间仍能补齐通知 |
| 凭证治理 | `object_store.rs`、`manager/v4_engine.rs` | 脱敏 Debug、session generation 隔离、5 分钟提前续期、402 降级只读 |

## 三、本次已落地的改动（Step 1：不改协议、不改行为）

### 1. 连接复用（`store.rs`、`store/schema.rs`）

原实现每个存储方法都 `Connection::open` + 三条 PRAGMA，而 checkpoint 是**每完成一个文件调一次**。一次 500 文件的 pass ≈ 500+ 次建连。

改为：`SyncStore` 持有 `Arc<Mutex<Option<Connection>>>`，`open()` 返回实现 `Deref<Target = Connection>` 的 `StoreConnection` 守卫，27 个调用点写法不变。

配套处理了三个必须一起改的点：

- **锁序固定**：始终 `schema_lock → connection`，反向无人获取，不会死锁。
- **数据库文件被替换时必须丢弃句柄**：`initialize_schema_locked` 与 `initialize_runtime_schema` 的重建分支先清空池，否则旧句柄指向已 unlink 的 inode，后续写入静默丢失。
- **新增两个回归测试**：`pooled_connection_observes_commits_from_other_handles`（池化句柄不能把读事务钉住）、`pooled_connection_does_not_survive_a_database_rebuild`（重建后写入必须落到当前文件）。

**没有做 checkpoint 合批**：连接复用后单次 checkpoint 只剩一条 UPDATE，而 `WAL + synchronous=NORMAL` 下提交不落盘；合批会把「最多丢 1 个文件进度」放大到「最多丢 N 个」，用耐久性换来的收益已经不成立。

### 2. 阻塞 I/O 离开 async worker（`blocking.rs`、`v4_apply.rs`、`v4_pass/execution.rs`）

`LocalStore` 的 read/write/archive 是同步的（文件锁、原子 rename、stat），原来直接在 future 里调用；4 路上传并发时足以占满 runtime worker。

改为：新增 `blocking::run`，在多线程 runtime 上走 `block_in_place`（把其余任务先迁走），current-thread runtime 直接执行（`block_in_place` 在那种 runtime 上会 panic，所以先判 flavour）。再以 `OffThread` 包装器整体代理 `LocalStore`，调用点零改动；`write_if_unchanged` 显式覆写，避免 read+write 两次 hop。SHA-256 也一并移出 worker。

### 3. 失败可编程（`error.rs`、`v4_apply.rs`）

`ApplyFailure` 增加 `kind: FailureKind`：`Transient / Permission / Quota / Local / Unsupported / Storage / Unknown`，由 `SyncError::failure_kind()` 统一映射（401/403 → Permission，402 或 code 含 QUOTA → Quota，413 → Unsupported，404/409/412/5xx → Transient）。`kind.is_retryable()` 供重试循环与状态 UI 判断。25 个构造点全部改为 `from_error` / `of` / `unsupported`，不再靠文本匹配。

## 四、未做，留给后续

| 项 | 原因 | 建议 |
|---|---|---|
| 大附件流式 / 分片上传 | 需要改 `put_object` 契约与签名重试路径，属于行为改动。全量复制已消除（见 §8），内存峰值从 2× 降到 1× 文件大小 | 要把峰值降到 O(chunk)，需要让签名覆盖 `UNSIGNED-PAYLOAD` 或先算分片摘要，再走 multipart |
| 全局单 pass 锁 → per-notebook | 需要先确认 `set_pending_deletions` 的整表替换语义 | 同 notebook 互斥、不同 notebook 并发，全局上限 2~3 |
| 前端「确认批量删除」入口 | 后端已提供 `PassRequest.allow_mass_deletion` 与 `deletion_deferred` 标志，缺的是把按钮接到它上面 | 在同步状态条上显示「N 项删除待确认」，确认后用 `allow_mass_deletion: true` 重跑一轮 |
| pass 级故障注入测试 | 已补 412 / 无 ETag / 墓碑被替换三条（§10），分页中途失败与配额耗尽仍只有决策层用例 | 复用 `reconcile_simulation.rs` 的思路扩到 pass 层 |

## 五、验证状态

- `cargo test -p flowix-sync` → **202 passed**（199 lib + 3 integration），0 failed。新增用例：2 个池化连接回归测试、2 个 `FailureKind` 分类测试。
- `cargo check -p flowix-sync --all-targets` 与 `cargo check -p flowix-desktop --all-targets` 均通过，无新增 warning。
- `flowix-desktop` 的测试二进制未运行：本机磁盘已接近写满（构建中途出现过 `No space left on device`），链接测试目标需要数 GB 余量。改动只涉及失败构造方式，消息文本未变，涉及的两个断言不依赖 `kind`。

建议在有余量时补跑：

```bash
cargo test -p flowix-desktop
cargo clippy -p flowix-sync -p flowix-desktop --all-targets
```

### 本次改动涉及的文件

| 文件 | 改动 |
|---|---|
| `src/store.rs` | `SyncStore` 增加 `Arc<Mutex<Option<Connection>>>`，新增 `StoreConnection` 守卫与 `drop_connection` |
| `src/store/schema.rs` | `open()` 复用句柄；`ensure_schema` 收敛初始化；重建/替换数据库文件时先丢弃句柄；新增 2 个回归测试 |
| `src/blocking.rs`（新） | `blocking::run`：多线程 runtime 走 `block_in_place`，其余直接执行 |
| `src/v4_apply.rs` | 新增 `OffThread` 包装器代理全部 `LocalStore` 调用；SHA-256 移出 worker；`ApplyFailure` 增加 `kind` 与构造器 |
| `src/error.rs` | 新增 `FailureKind` 与 `SyncError::failure_kind()` |
| `src/v4_pass/{planning,execution}.rs`、`src/v4_pass.rs` | 失败构造改为 `from_error` / `of` |
| `src/lib.rs`、`src/v4_pass/..` | 模块注册与导入 |
| `Cargo.toml` | tokio 增加 `rt-multi-thread`（`block_in_place` 需要） |
| `flowix-desktop/src/commands/cloud/path_sync_runner.rs` | 扫描失败标记为 `Unsupported`，测试构造改用构造器 |

## 六、Step 2：`v4*` 命名清理（已完成）

仓库里已经没有 v2 引擎，`v4` 前缀不再携带任何信息，反而让新人以为存在并行版本。本次按「模块 / 类型 / 存储方法」三层统一改名，**不改任何行为**。

| 旧 | 新 |
|---|---|
| `src/v4.rs` | `src/state.rs` |
| `src/v4_apply.rs` / `v4_apply_tests.rs` | `src/apply.rs` / `apply_tests.rs` |
| `src/v4_pass.rs` / `v4_pass/{planning,execution,state}.rs` | `src/pass.rs` / `pass/{..}.rs` |
| `src/store/v4.rs` / `store/v4_tests.rs` | `src/store/state.rs` / `store/state_tests.rs` |
| `src/manager/v4_engine.rs` | `src/manager/engine.rs` |
| `flowix-desktop/.../v4_adapter.rs` | `.../path_sync_adapter.rs` |
| `V4PathState` / `V4NotebookState` / `V4DirectoryState` / `V4LocalSnapshot` | `PathState` / `NotebookState` / `DirectoryState` / `LocalSnapshot` |
| `V4PassInput` / `V4PassSummary` / `V4RunReport` / `V4CredentialCache` / `V4PassCredentialResolver` | `PassInput` / `PassSummary` / `RunReport` / `CredentialCache` / `PassCredentialResolver` |
| `SyncStore::v4_save_path_states` 等 26 个方法 | 去掉 `v4_` 前缀（`save_path_states` …） |
| `SyncManager::v4_http` / `v4_credentials` / `v4_pass_lock` … | `http` / `credentials` / `pass_lock` … |

**刻意保留的 `v4`**：

- SQLite 表名与索引名（`v4_path_state`、`v4_dir_scan`、`v4_pending_stamp`、`v4_notebook_state`、`v4_directory_state`、`idx_v4_path_state_pending`）。它们已经写进每个用户的磁盘，改名要配迁移且对用户零收益。已在 `store/state.rs` 顶部注明。
- 凭证 scheme 字面量 `"s3-v4"`：参与 `credential_fingerprint`，改名会让所有已绑定笔记本被判定为「换了 bucket」。

### 一次需要记录的事故

改名脚本第一版用 `re.split(pattern, text)` 切分字符串字面量，而正则没有捕获组 —— `re.split` 在这种情况下**丢弃分隔符**，于是整个 crate 的字符串字面量被删空（`format!("\"{}\"")` 变成 `format!()`）。损坏发生在 50 个文件上。

恢复过程与结论：

- 会话记录（Read 结果 + Write/Edit 参数）重放出 22 个文件的真实内容，覆盖 `apply.rs`、`reconcile.rs`、`pass/*`、`state.rs`、`store/state.rs`、`manager/engine.rs`、`object_store_ops.rs` 等主干。
- 未在会话中读过的文件分两类：与 HEAD 一致的（`git checkout HEAD` 精确还原）、含未提交改动的（按「损伤等价」判据识别，再用行级对齐把未提交 hunk 贴回 HEAD 原文）。
- **`apply_tests.rs`、`pass_tests.rs`、`store/state_tests.rs`、`reconcile_tests.rs` 的部分未提交改动无法恢复**：这些文件的当前内容来自 HEAD，或由对齐重建得到。4 个用例因此被 `#[ignore]` 标注（原因写在属性里），需要按新设计重写。

### 一个必须知道的设计分叉

HEAD 上的决策层是「删除确认窗口」：远端 key 消失后要观察满 `DELETE_CONFIRM_WINDOW_MS` 才允许删除本地。工作区里未提交的改动已经把它换成了另一套设计：

- 成功列出的目录里 key 缺失 → 直接判为删除；
- 本地删除 → 立刻写 tombstone，但带 `If-Match`（`Tombstone::expected_etag`）；
- 远端在此期间被改过 → PUT 得到 412，下一轮按「删除冲突」处理（`DownloadReason::RemoteUpdateAfterDelete`，标签 `download:delete-conflict`）。

本次以**工作区这套新设计**为准完成恢复，`reconcile_tests.rs` 里对应的断言（原先是 `defer:delete-unconfirmed`）已改为 `delete-local` / `write-tombstone`，决策表里两行重复的「窗口内等待」合并。

## 七、验证状态（Step 1 + Step 2）

- `cargo test -p flowix-sync` → **184 passed / 0 failed / 4 ignored**，integration 3 passed。
- `cargo check -p flowix-sync --all-targets`、`cargo check -p flowix-desktop --all-targets` 均无错误。
- `cargo clippy` 与 `flowix-desktop` 的测试二进制未跑：磁盘曾两次写满（`No space left on device`，`.git/index.lock` 都写不进去），本机现在只剩约 1 GB。`.build/cargo-target` 占 **21 GB**，`cargo clean` 是唯一能立刻腾出空间的操作，需要你确认后再执行。

## 八、Step 3：结构收尾（已完成）

四项改动都是机械搬动或签名收敛，**协议与行为不变**，靠 184 个测试兜底。

### 1. `object_store.rs`（1295 行）拆成四个模块

| 文件 | 内容 | 行数 |
|---|---|---|
| `object_store/mod.rs` | 模块文档、再导出、单元测试 | 437 |
| `object_store/credentials.rs` | 凭证结构、有效期、`CredentialResolver`、配额契约 | 209 |
| `object_store/transport.rs` | 单次带凭证续期的缓冲请求 | 97 |
| `object_store/signing.rs` | SigV4 + COS v5 签名与摘要工具 | 320 |
| `object_store/listing.rs` | `ListObjectsV2` 查询、分页校验、固定形状 XML 读取 | 293 |

切分用行号切片而不是正则改写（`.build/split_object_store.py`）：每个切片断言首行内容，只对跨模块需要的 6 个符号提升可见性（`tag`、`validate_list_response`、`encode`、`hex`、`hmac_sha256`、`is_expired_token_response` → `pub(crate)`），`mod.rs` 用 `pub use` / `pub(crate) use` 维持原路径，因此 `object_store_ops`、`pass`、`engine`、`lib` 的 9 处外部引用一行未改。

### 2. 六个入口点共用 `PassCredentials`

`remote_notebooks`、`get_notebook_manifest`、`put_notebook_manifest`、`remote_directories`、`put_directory_marker`、`pass` 原先各自重复「解析凭证 → 克隆 → 构造 resolver」三行。现在统一走 `SyncManager::pass_credentials`，一次返回 `PassCredentials { credentials, quota, resolver }`：

```rust
let PassCredentials { credentials, quota: _, resolver } =
    self.pass_credentials(now.timestamp_millis()).await?;
```

凭证与 resolver 由同一处产出，漏掉 clone 或漏掉「固定本轮 mode」的写法不再可能。

### 3. `apply` 的参数塔收敛为 `ApplyOptions`

`apply_with_progress` 原来 10 个位置参数，尾部是 `sizes: Option<&BTreeMap<..>>` 加两个 `Option<&dyn Fn>`，调用点写 `None, None` 无法自解释。改为 `ApplyOptions { sizes, on_transfer, on_progress }`（`Default` 派生），函数入口解构一次，内部逻辑零改动。

### 4. `PUT` 去掉全量复制

`put_object` 的 body 从 `&[u8]` 改为 `bytes::Bytes`，闭包内 `body.clone()` 只是引用计数递增。原来是 `copy_from_slice`：凭证续期会让一次 PUT 尝试两遍，4 路上传并发时峰值内存是 `2 × 4 ×` 文件大小，大附件直接翻倍。`upload` / `upload_with_progress` 同步改为接收 `Bytes`，`apply::upload_one` 里读出的 `Vec<u8>` 通过 `Bytes::from` 零拷贝转移。

## 九、验证状态（Step 1 + Step 2 + Step 3）

- `cargo test -p flowix-sync` → **184 passed / 0 failed / 4 ignored**，integration 3 passed。
- `cargo test -p flowix-desktop --lib` → **851 passed / 7 ignored**，1 个并发失败：`agent_external::shared::tests::cancelled_start_rejects_a_late_child`（它 `Command::new("true")` 起子进程，并行跑时报 `NotFound`，单独跑通过）。与云存储无关，属既有环境敏感用例。
- `cargo check -p flowix-sync --all-targets`、`cargo check -p flowix-desktop --all-targets` 均通过，`flowix-desktop` 的 94 条 warning 无一条指向 `flowix-sync`。
- `cargo clippy -p flowix-sync --all-targets` → 8 条 warning，全部是既有的 `too_many_arguments` / `type_complexity` / `enum_variant_size` / `derivable_impls` 风格项；拆出的 `object_store/*` 四个模块零告警。本轮顺手把两处重复书写的回调类型收成 `TransferObserver` / `ProgressObserver` 别名，告警从 11 降到 8。

### 本轮涉及的文件

| 文件 | 改动 |
|---|---|
| `src/object_store/{mod,credentials,transport,signing,listing}.rs` | 由单文件 1295 行拆出，原路径与符号不变 |
| `src/manager/engine.rs` | 新增 `PassCredentials` 与 `pass_credentials`，6 个入口点改用；`PassInput` 的回调类型改用别名；2 处 `put_object` 传 `Bytes` |
| `src/apply.rs` | 新增 `ApplyOptions`、`TransferObserver` / `ProgressObserver`，`apply_with_progress` 由 10 参降为 8 参；上传路径零拷贝移交 body |
| `src/object_store_ops.rs` | `put_object` / `put` / `upload` / `upload_with_progress` 接收 `bytes::Bytes` |
| `src/pass.rs`、`src/pass/execution.rs` | 调用点与函数签名适配 |

**当时留下的 4 个 `#[ignore]`** 已在 §10 全部重写转正，现在没有任何被跳过的用例。


## 十、Step 4：删除路径的测试与闸门（已完成）

### 1. 四个 `#[ignore]` 全部转正

它们不是「跑不过」，是断言写在旧设计上。逐个查清后按新语义重写：

| 用例 | 原断言为什么不成立 | 现在验的是 |
|---|---|---|
| `read_only_official_proxy_…` | 状态行没有 `remote_etag`，`reconcile` 把它判成「对象可能被换过」，于是走 `download:delete-conflict` 而不是写墓碑 | `defer:read-only` + `write-tombstone` 同时出现在计划里 |
| `read_only_proxy_executes_…` | 同上，计划里根本没有墓碑，代理自然没被调用 | 真正调了代理、`If-Match` 用的是清单观测到的 ETag、状态行与待发戳都被收尾 |
| `failed_proxy_deletion_…` | `pending_since` 不再充当确认窗口，只有「重开目录」一个作用 | 失败后保留首见时间、重试走队列而不是全量重扫 |
| `tombstone_replaced_before_head_…` | 无条件墓碑改成 `If-Match` 后，`expected_etag: None` 直接本地拒绝，一个请求都不发，而假服务器在等两个请求 —— 于是**挂住** | 同样的场景补上 ETag：两次请求、`if-match` 头正确、基线不被删除 |

顺带修掉一个测试基建地雷：`object_server` 按「响应条数」等连接，客户端少发一个就永久阻塞。新增 `object_server_recorded`，按超时收敛并把收到的请求回传，断言可以直接检查 `if-match` 这类头。

### 2. 三条故障注入

- `a_rejected_conditional_tombstone_keeps_the_path_pending`：PUT 返回 412 → 只发一个请求，不发 HEAD（否则会把赢家读成「删除已完成」），失败归类 `Transient`。
- `a_tombstone_without_an_observed_etag_is_refused_locally`：没有观测过 ETag 就不许写，且请求一个都不发。
- `tombstone_replaced_before_head_does_not_remove_baseline`：PUT 成功但 HEAD 看到的是活对象 → 保留基线，`deletion_remains pending`。

### 3. 批量删除从「整轮失败」改成「暂缓这批删除」

旧实现：删除数 ≥ 20 且 ≥ 已知文件一半 → 整轮 `Err`，不写 checkpoint。用户删一个有 100 个文件的文件夹就永久同步失败，而前端从来不处理 `CLOUD_MASS_DELETE_BLOCKED`（全仓搜过，只有 planning 自己和它的测试提到过）。

现在：

- 只把删除动作转成 `defer:mass-deletion`，上传/下载照常执行并 checkpoint；
- 每个被拒路径写 `pending_since`，下一轮重新打开所在目录（否则目录戳没动，这些路径再也不会被看到）；
- 只保留仍有写入的目录的戳，避免其他设备每轮空重列；
- `stats.mass_deletion_deferred` 计数，桌面侧 `deletion_deferred` 同时涵盖 `GracePeriod` 与 `MassDeletion`；
- 放行入口是 `PassRequest.allow_mass_deletion`（由 `PassInput` 透传），引擎自己永不置真。

覆盖面：4 条新用例，包含两个方向（远端墓碑 → 删本地；本地删文件夹 → 写墓碑）与「确认后照常执行」。

## 十一、Step 5：批量删除改成「问一次」而不是「永远挡着」（已完成）

Step 4 把「整轮失败」换成了「暂缓」，但暂缓没有出口：桌面端把 `allow_mass_deletion` 恒设为
`false`，用户看到「删除已暂停」之后什么也做不了，删除永远不落地。产品上的结论是：

> 删除就同步删除。只有「一次删掉一半以上」需要问一次。

### 1. 阈值（含最小数量）

`pass/planning.rs`：`deletions >= 20` **且** `deletions * 2 >= known_paths` 才提示。两个条件必须同时
满足，所以「删掉笔记本里 20% 的一个文件夹」不会打扰用户——日常删除不受影响。

### 2. 两个方向，两种后果

闸门对两个方向都生效，因为它们删的是不同的副本：

| `DeferReason` | 触发场景 | 继续同步会 | 撤销时数据从哪来 |
|---|---|---|---|
| `MassDeletionRemote` | 本机少了一批文件，云端还有 | 删除云端副本（其他设备唯一的来源） | 云端 → 本机（`download:new`） |
| `MassDeletionLocal` | 云端已删了一批，本机还有 | 删除本机文件 | 本机 → 云端（`upload:resurrect`） |

方向决定文案，也决定「撤销」的方向；`Defer.path` 保留了路径，桌面侧据此按方向计数。

### 3. 撤销为什么是「丢掉状态行」

`SyncManager::restore_paths` 只做两件事：删掉这些路径的 `v4_path_state` 行、把它们所在的目录塞进
`v4_pending_stamp`。丢掉行之后，两条分支各自给出正确结果：

- 本机没有该文件 → `(None, Observed(object))` 且 `baseline == None` → 下载回来；
- 本机还有该文件、远端是墓碑 → `deleted_after_our_last_sync == false` → `upload:Resurrect` 复活。

这不是巧合：`reconcile_tombstone` 把「没有基线」解释成「无法主张这是删除」，两个方向共用同一判断。
重开目录是必需的，否则目录戳没动，下一轮根本不会看这些路径。

### 4. 确认是一次性的

`SyncManager::allow_next_mass_deletion` 把笔记本 id 放进一个内存集合，`pass()` 取用即删：

- 不持久化——重启后没人能对上一次看到的批次负责；
- 按 notebook 分——在一个笔记本上确认，不等于授权另一个；
- 一次性——一次「确认」不会变成长期许可。

### 5. 桌面与 UI

- `PassSummary` 带 `MassDeletion { local, remote, paths }`；`CloudSyncStatus` 暴露
  `massDeletionLocal` / `massDeletionRemote`；
- 新命令 `cloud_resolve_mass_deletion(notebookId, restore)`：`false` 是确认、`true` 是撤销，两者都会
  立刻触发一轮同步，不等 10 秒轮询；
- `features/shell/components/status-bar/mass-deletion-dialog.tsx`：标题「大量文档被删除，继续云同步？」，
  按方向给出后果句，附「确认删除后，被删除内容不可恢复」，两个按钮「撤销删除」/「确认」；
- 关闭对话框等于「暂不决定」，同一批次不会再自动弹（按 `notebookId + 两个计数` 记住），计数变化才会再问。

### 6. 性能：删除路径没有新增工作

`delete_folder` / `delete_file` 是纯本地操作（`spawn_blocking` + `remove_dir_all` + 索引对账），不调用
同步代码。闸门与对话框都在之后的 pass 与状态推送里，删除耗时不受影响。

## 十二、验证状态（Step 1 – Step 5）

- `cargo test -p flowix-sync` → **201 passed / 0 failed / 0 ignored**，integration 3 passed。`#[ignore]` 清零。
- `cargo test -p flowix-desktop --lib` → **852 passed / 0 failed / 7 ignored**。上一轮那个环境敏感用例已修：
  `cancelled_start_rejects_a_late_child` 原来用 `Command::new("true")`，会撞上别的用例把 `PATH` 改成空串的
  窗口；改成 `/bin/sh -c "exit 0"`（Windows 用 `%COMSPEC%`）后连跑 4 轮全绿。
- 前端：`tsc --noEmit`、`eslint` 干净；新增的 `mass-deletion-dialog.test.tsx` 4 passed；
  `features/shell` 全量 72 passed，唯一失败是 `use-document-titlebar-props.test.tsx`（与云同步无关、
  工作区未改动的既有失败）。
- `cargo check -p flowix-sync --all-targets`、`cargo check -p flowix-desktop --all-targets` 通过。
- `cargo clippy -p flowix-sync --all-targets` → 8 条，全是既有的 `too_many_arguments` / `type_complexity` / `enum_variant_size` / `derivable_impls`。
- 新写的代码 `rustfmt --check` 干净；文件里剩下的格式差异都是之前恢复时留下的（import 顺序、行末空行）。

## 十三、P1 架构债清理（已完成）

评审时留下的六条 P1，逐条落地。前三条是「让声明与运行时不打架」，后三条是「把隐式约定变成显式结构」。

### 1. `protocolEpoch` 从 TS 类型里删掉

`CloudState.account.protocolEpoch: 3` 在 Rust 的 `CloudAccount` 里没有对应字段，也没有任何读取点——
它只是类型声明里的一个常量。服务端的 `protocolEpoch` 只出现在历史索引导出的响应里（`/v1/export`），
登录响应不带它，所以补到 Rust 侧等于把同一个假设搬到后端。删除字段，以及 5 处测试里的字面量。

### 2. 凭证新鲜度不再只看设备时钟

- `CredentialResolver` 新增 `now()` 与 `observe_server_time()`（默认实现是设备时钟 + 空操作，自定义 S3 不受影响）。
- `transport` 每收到一个响应就解析 `Date` 头并回喂给 resolver；签名、续签判断、`usable()` 全部改用
  `resolver.now()`。
- `SyncManager` 持有 `ClockSkew`（设备时钟 + 最近一次观察到的偏移），`PassCredentialResolver` 把它接出去。
  偏移超过 24 小时视为垃圾头直接忽略，避免一次代理缓存把后续签名带偏。
- 效果：设备时钟快几分钟不再每个请求都续签，慢几分钟也不会拿着一张已退役的授权签名。

### 3. 写锁覆盖所有写入口

`pass_lock` 改名 `write_lock`，`put_notebook_manifest` / `put_directory_marker` 与 `pass()` 共用同一把
tokio 锁。仅覆盖 pass 的锁是名义上的互斥：发布 manifest 描述的是 pass 正在改的那棵树。

### 4. `plan_pass` 不再写库

拆成两步：

- `prepare_pass(...) -> PreparedPass`：列目录戳、取服务端时间、必要时 `bind_if_needed`（唯一的写库点）、
  读 `notebook_state` 与 `snapshot`；
- `plan_pass(source, request, PreparedPass, deletion_proxy)`：只读输入，产出 `ReconcilePlan`。

`run_pass_with_progress` 先 prepare 再 plan。测试里 25 处调用通过一个 `plan()` 辅助函数收口。

### 5. `\0proxy/` 魔法前缀变成一张表

代理删除原先塞在目录戳队列里，用 NUL 前缀的伪路径区分，读这张表的每一处都必须知道这个约定。
新增 `v4_pending_proxy_delete(notebook_id, path)` 与 `queue_proxy_deletions` / `pending_proxy_deletions` /
`ack_proxy_deletion`，`flush_pending_stamps` 里的跳过判断随之删除。

迁移在 `initialize_state_schema`：把旧表里 NUL 前缀的行搬到新表再删掉。匹配逻辑放在 Rust 而不是 SQL——
SQLite 的 `LIKE` / `substr` 遇到 NUL 会截断，`char(0)` 比较也不可靠。有回归测试覆盖。

### 6. 死代码

`SyncManager::forget_credentials` 无调用点，删除。缓存失效本来就有两条活路：`CredentialCache::usable()`
在会话代际变化时直接判为不可用，`PassCredentialResolver` 在删除代理成功后主动失效一次。

### 验证

- `cargo test -p flowix-sync` → **204 passed / 0 failed / 0 ignored**，integration 3 passed（新增：代理删除迁移、
  时钟偏移；`plan_pass` 拆分后原 202 条全部保持通过）。
- `cargo clippy -p flowix-sync --all-targets` → 7 条，均为既有告警；顺手把 `planning.rs` 里「测试模块之后的
  条目」这一条整理掉（测试模块移到文件末尾）。
- 改动的 11 个文件 `rustfmt` 干净。
