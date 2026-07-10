# Flowix 生产级别架构审查报告

> **审查日期**：2026-06-15
> **审查范围**：整个 `flowix-main` 仓库（Rust workspace + React 19 + Tauri 2 + AI 集成）
> **审查方法**：6 个并行专门 agent 深度阅读源码，分别覆盖安全、错误处理与并发、AI/LLM 集成、前端质量、数据完整性、构建/发布/可观测性

经统计共发现 **120+ 项需关注问题**。本文按 "上线阻断级 → 高优 → 中优 → 亮点" 分层呈现，每条都附 `file:line` 与一句修复指引。

---

## 目录

- [🚨 P0 — 上线阻断（修复前不应分发）](#-p0--上线阻断修复前不应分发)
- [🔴 P1 — 高优（影响线上稳定 / 用户数据）](#-p1--高优影响线上稳定--用户数据)
- [🟡 P2 — 中优（技术债 / 体验影响）](#-p2--中优技术债--体验影响)
- [✅ 已经做得不错（请保留）](#-已经做得不错请保留)
- [📋 推荐执行顺序（ROI 排序）](#-推荐执行顺序roi-排序)
- [一句话总结](#一句话总结)

---

## 🚨 P0 — 上线阻断（修复前不应分发）

### P0-1. AI 工具沙箱被绕过：模型可读写任何用户曾授权过的目录

**位置**：[`providers/tools/filesystem.rs:144-160, 213-262`](../app/flowix-desktop/src/providers/tools/filesystem.rs) + [`providers/tools/mod.rs:124-128`](../app/flowix-desktop/src/providers/tools/mod.rs)

`ToolScope` 信任 `~/.flowix/agent_access.json` 中任何"文件夹"条目。LLM 可以 `write` 到 `~/.ssh/authorized_keys`、`~/.aws/credentials`、`~/.zshrc`，配合 `create_dirs: true` 默认开启，目录尚不存在也会被创建；再叠加用户记录在某 note 里的恶意指令 → **prompt injection → 完整本机控制链**。

**修复**：硬编码 "AI 工具只允许 notebook 根目录及其 `attachments/` 子目录"，禁止从 `agent_access.json` 动态扩权；`metadata().is_symlink()` 逐段检查；禁掉 `create_dirs`。

---

### P0-2. API Key 明文流通：本地 JSON + 经 IPC 完整回传给 renderer

**位置**：
- 存储 [`user_config.rs:86-126, 243-252`](../app/flowix-desktop/src/user_config.rs)
- 暴露 [`commands/settings.rs:43-45`](../app/flowix-desktop/src/commands/settings.rs)
- 消费 [`agent-panel/agent-root.tsx:107-110`](../app/flowix-web/windows/main/agent-panel/agent-root.tsx)

- 存储：`~/.flowix/ai_config.json` 明文（POSIX 上 0o600，Windows 上 `set_file_owner_only_perms` 是 no-op）。
- 传输：`get_ai_config` 把含 `api_key` 的整个 `AiConfigFile` 还给前端，Zustand 持久化到 webview localStorage。

**修复**：用 `keyring` / `tauri-plugin-stronghold` 走 OS keychain；后端只回 `{ provider, model, apiUrl, hasKey: true }`，密钥永不过 IPC；Windows 端用 ACL 加固。

---

### P0-3. `write_export_file` 后端**完全没做**作用域检查

**位置**：[`commands/dialog.rs:276-281`](../app/flowix-desktop/src/commands/dialog.rs)

```rust
#[tauri::command]
pub fn write_export_file(file_path: String, content: String) -> bool {
    write_bytes_to_path(&file_path, content.as_bytes())   // 任意路径写
}
```

注释自承"已在 caller 侧加弱校验"。任意 XSS / 恶意 npm 依赖 / 调试人员手抖一行 JS → 改 `~/.flowix/ai_config.json`、改 `.bashrc`、覆盖 App bundle。

**修复**：在 Rust 端强制 "必须落在用户最近一次通过 native dialog 选定的导出目录内"，限制扩展名 + 内容大小。

---

### P0-4. CSP 三处大开口 + assetProtocol 通配

**位置**：[`tauri.conf.json:30-36`](../app/flowix-desktop/tauri.conf.json)

- `script-src 'unsafe-eval'`、`style-src 'unsafe-inline'`、`connect-src https:`（任何 HTTPS 主机），`assetProtocol.scope: ["**"]`（整个磁盘可经 `asset://` 取走）。
- 配合 P0-2 的 API key → **一次 XSS 即可把密钥 POST 到攻击者域名**，CSP 没有任何阻拦。

**修复**：`connect-src` 收窄到 `api.openai.com api.anthropic.com api.deepseek.com`；`assetProtocol.scope` 收窄到 notebook 根；删 `unsafe-eval`；Vite 仅在 dev 注入。

---

### P0-5. 笔记 `.md` 全部使用**非原子** `fs::write`，掉电即损坏 [已完成]

**位置**：[`flowix-core/src/memo_file/ops.rs:177, 249, 278, 358, 473, 567`](../app/flowix-core/src/memo_file/ops.rs) + [`commands/memo.rs:324`](../app/flowix-desktop/src/commands/memo.rs)

- 对照：`index.json`、`notebook.json` 的 JSON 写入已经走了 `tempfile + rename`，唯独**用户最在意的正文**没保护。
- 进一步：内部 memo 写入**没有任何乐观并发控制**（`commands/memo.rs:225-277`）—— Tiptap 与 CLI 同改一篇，后写者静默吞掉前者。

**修复**：抽 `atomic_write_md(path, bytes)` = `tmp + sync_all + rename`（Windows 上配合 `dunce`），全部替换；把 `updatedAt` 当 revision 做 CAS。

---

### P0-6. `devtools: true` 写死在生产窗口配置 [已完成]

**位置**：[`tauri.conf.json:26`](../app/flowix-desktop/tauri.conf.json)

用户在 release 包里按 F12 即可读 React state、伪造 IPC、改 stream payload。`lib.rs` 中只有 `open_devtools()` 调用是 `#[cfg(debug_assertions)]`，没有覆盖窗口属性。

**修复**：改 `"devtools": false`，让 `open_devtools()` 在调试模式下显式开。

---

### P0-7. AI 文件系统工具全部在 `async fn` 内部直接 `std::fs::*` / `WalkDir` [已完成]

**位置**：[`providers/tools/filesystem.rs:178-480`](../app/flowix-desktop/src/providers/tools/filesystem.rs)（read/write/edit/ls/glob/grep 全部命中）+ [`agent.rs:1483`](../app/flowix-desktop/src/agent.rs)

ReAct 循环每次 `.await` 都把 Tokio worker 卡死，单线程 runtime 直接冻 UI；`grep` 还会无 yield 走完整个目录树。

**修复**：用 `tokio::fs` 或包 `spawn_blocking`；`grep`/`glob` 增加文件数与时长上限。

---

### P0-8. README 承诺的 CI/CD 不存在

- 仓库内**无** `.github/workflows/` 任何文件；[`README.md:211, 423`](../README.md) 提到的 `release.yml` 也是空的。

**修复**：补 PR 构建 + 跨平台 release matrix；同时配 `cargo audit / cargo deny / npm audit`。

---

### P0-9. CLI sidecar 与 bundle **完全没签名** [已完成]

**位置**：[`scripts/build-cli.sh:43-77`](../scripts/build-cli.sh) + [`tauri.conf.json:65-67`](../app/flowix-desktop/tauri.conf.json)

- macOS 上 hardened runtime 拒绝 exec 未签名 sidecar → Agent 功能直接挂；Windows SmartScreen 隔离 inner binary → 同样挂。

**修复**：`scripts/sign-cli.sh` 走 `codesign --options runtime --timestamp` + `notarytool`；Windows 加 `signtool` + `certificateThumbprint`；bundle 配 `signingIdentity` 与 `entitlements`。

---

## 🔴 P1 — 高优（影响线上稳定 / 用户数据）

### 锁与并发

- **大面积 `RwLock::read().unwrap()` / `write().unwrap()`** 散布在 `commands/memo.rs`、`commands/helpers.rs`、`commands/notebook.rs`、`open_target/resolver.rs`（~40 处）。一次中毒后续每个 IPC 都会 panic → 整体不可用。对照 [`threads.rs:176-181`](../app/flowix-desktop/src/threads.rs) 已做的 `unwrap_or_else(|p| poisoned.into_inner())`，建议复用，或干脆换 `parking_lot::RwLock`（无中毒）。
- [`fs_watcher.rs:160-215`](../app/flowix-desktop/src/fs_watcher.rs) `rebind()` 在 `inode_tracker.lock()` 持锁状态下迭代 `read_dir` 并逐项 `metadata` 系统调用，10k 笔记会让 watcher 线程长时间卡死。
- [`watcher/filter/mod.rs:120-138`](../app/flowix-desktop/src/watcher/filter/mod.rs) 的 `Debouncer` 仅按"最后发射时间"判断，高频写会丢真实变更；`SelfWriteSuppressor` 没有清扫任务，长跑后会累积。
- AI 自写循环风险：[`agent.rs:1455-1466`](../app/flowix-desktop/src/agent.rs) 的 `mark_self_write` 在 `execute_tool` 之**后**注册，FSEvents 抢跑就会被识别为外部修改 → 状态翻车。**应改到调用前注册**。

### 错误处理

- `unwrap()`/`expect()` 在启动期：[`lib.rs:286, 293`](../app/flowix-desktop/src/lib.rs) `GlobalMetaData::new(...).expect(...)`、`ThreadManager::new(...).expect(...)` —— `~/.flowix/` 不可写或 SQLite 不可开 → app 直接 panic 退出。改为 tracing + 弹窗 + 优雅退化。
- 全工程**没有一处** `anyhow::Context` / `eyre::WrapErr`（grep 验证）。前端只看到 `"io error: ..."` 不带路径与操作。`user_config.rs:148` 的 `#[error("io error: {0}")]` 是典型示例。
- [`commands/file.rs:122-206`](../app/flowix-desktop/src/commands/file.rs) 所有 IPC 用 `.is_ok()` / `.ok()` 把错误吃掉变 `bool`，错误信息只走 `eprintln!`。改成 `Result<_, String>`。
- 前端 `ErrorBoundary` 只在根包一层（[`App.tsx:131-164`](../app/flowix-web/App.tsx)），任一子树 panic 整个窗口变 fallback；且 [`error-boundary.tsx:27-30`](../app/flowix-web/components/error-boundary.tsx) 仅 `console.error`，没有任何上报。
- [`chat-store.ts`](../app/flowix-web/lib/store/chat-store.ts) 有 10+ 处 `console.error('Failed to ...', err)` 全静默，用户感知不到失败。

### AI / LLM

- **流式无总时长上限**：[`providers/openai_compatible.rs:428`](../app/flowix-desktop/src/providers/openai_compatible.rs) 每帧 120s read timeout × ReAct 100 cycle，极端情况一次"卡死"chat 可耗几小时。每 cycle 应包 `tokio::time::timeout`。
- `read` 工具未做"先看文件大小"，直接 `fs::read_to_string` 整盘吞入（[`tools/filesystem.rs:180-201`](../app/flowix-desktop/src/providers/tools/filesystem.rs)）——一个 200MB 日志即可 OOM。
- `write` 工具 `args.content: String` 无大小约束（同文件 213-262），LLM 单次 2GB 写入塞满磁盘。
- **无 429 / 5xx 重试**：[`providers/openai_compatible.rs:586-593`](../app/flowix-desktop/src/providers/openai_compatible.rs) 任意非 2xx → 终止整个 turn；`is_recoverable_args_error` 用 substring 匹配又匹配不上真实 error message → "兜底"形同虚设。
- **SSE 切包按 UTF-8 字符串处理 + 仅按 `\n` 切**：[`openai_compatible.rs:628-651`](../app/flowix-desktop/src/providers/openai_compatible.rs) —— 跨包多字节字符变 `U+FFFD`（中文文件名遭殃），Anthropic `\r\n` 与 `event:` 行型不被识别。改为 `Vec<u8>` 累积 + 行驱动。
- **Prompt injection 几乎没有结构化防御**：[`prompt/safety.rs`](../app/flowix-desktop/src/prompt/safety.rs) 仅一句风格嘱咐；tool 回填到 `MessageType::ToolResult` 时没包 sentinel 块，用户在 note 里写 `</system>...` 就能影响后续推理。
- **线程历史无上限，无加密**：[`threads.rs:273-313`](../app/flowix-desktop/src/threads.rs) `add_message` 无 size cap，单条 `tool_data` 可达 100KB+；SQLite 全程明文。

### 数据完整性

- `notebook.json` 也是非原子写：[`memo_file/notebook.rs:82-86`](../app/flowix-core/src/memo_file/notebook.rs) —— 写一半挂掉，下次启动用户**所有自定义 notebook 注册悄无声息消失**，因为 `read_notebook_configs` 走 `.unwrap_or_default()`。
- `index.json` 解析失败 → 笔记列表显示空，自动重建机制缺失（[`index_store.rs:48-77`](../app/flowix-core/src/memo_file/index_store.rs)）。应回扫磁盘 + 从 frontmatter 复原。
- **搜索索引不跟外部编辑器同步**：[`flowix-core/src/search.rs:18-26`](../app/flowix-core/src/search.rs) 自承"外部改了 .md 索引会过期"。watcher 已经 reload 了内容，却没顺手 `try_index_upsert`。一行修复，影响很大。
- 删除即真删，无回收站（[`memo_file/ops.rs:371-389`](../app/flowix-core/src/memo_file/ops.rs)）。`.trash/` 已经在 watcher skip_dirs 里预留了，建议直接落地。
- `index.json` 的 `version: u32` 字段被赋值但**没有任何迁移代码**，类型 doc 自承未来不兼容直接破坏老仓库（[`memo_file/types.rs:139-152`](../app/flowix-core/src/memo_file/types.rs)）。

### 前端性能 [已全部完成处理]

- **关键大组件整 store 订阅**（[`main-layout.tsx:75-92`](../app/flowix-web/windows/main/main-layout.tsx)、[`memo-list.tsx:168-183`](../app/flowix-web/windows/main/memo-pane/memo-list.tsx)、[`document-container.tsx:41-44`](../app/flowix-web/windows/main/document-pane/document-container.tsx)）——任何 `set` 都全树重渲。直接用 slice selector 即可。
- `MemoCard` **没有 `React.memo`**（[`memo-card1.tsx:51`](../app/flowix-web/windows/main/memo-pane/memo-card1.tsx)），列表里千张卡每次都重渲。
- `@tanstack/react-virtual` 是 dependency 但 `memo-list.tsx` / `chat-history.tsx` 都没用 —— 5k 笔记纯 `<div>` 排列直接卡死。
- [`codeblock-shiki/codeblock-shiki-view.ts:172-191`](../app/flowix-web/components/editor/extensions/codeblock-shiki/codeblock-shiki-view.ts) 注册 `document.addEventListener('click', ...)` 但 `destroy()` 没移除 → 每个代码块永久泄漏一个全局监听。
- `buffer-registry` 的两张 `Map`（[`buffer-registry.ts:111-112`](../app/flowix-web/lib/store/buffer-registry.ts)）无 LRU，长跑会话内存只涨不降。
- **死依赖**：`html2pdf.js / mammoth / pdf-parse` 全工程 0 引用。
- `react-syntax-highlighter` 在 [`markdown-renderer.tsx:4-5`](../app/flowix-web/windows/main/agent-panel/messages/markdown-renderer.tsx) 静态 import，250KB+ 进主 chunk。应 `React.lazy`。

### 路径安全（IPC）

- [`commands/file.rs:115-153`](../app/flowix-desktop/src/commands/file.rs) `read_file/write_file/delete_file` 用 `space_path` 做防护但未先 canonicalize；用户在 vault 里建一个 symlink 指向外部，整套机制即被绕过。
- [`commands/memo.rs:146-153`](../app/flowix-desktop/src/commands/memo.rs) 的 `is_markdown_like` 快捷判断让 renderer 可读写**磁盘上任何 `.md`**。
- Deep link `flowix://open?path=` 解析后**不做 path scope 校验**（[`open_target/parser.rs:184-198`](../app/flowix-desktop/src/open_target/parser.rs)），任何本机进程或诱导点击的网页都能让 Flowix 加载任意路径，可作存在性侦察。

---

## 🟡 P2 — 中优（技术债 / 体验影响）

### 构建与发布

- `bundle.targets: "all"` 在跨平台矩阵 CI 会**直接失败**（[`tauri.conf.json:42`](../app/flowix-desktop/tauri.conf.json)）—— 改成按 host 划分。
- 没有 `[profile.release]`：缺 `lto = "fat"`、`codegen-units = 1`、`strip = "symbols"` —— 包体大、冷启慢 100-200ms。
- 无 `tauri-plugin-updater`：用户没有应用内升级路径，仅靠 README 提示去 Releases 下载。
- `app/flowix-desktop/tauri.windows.conf.json` 存在但 `tauri.conf.json` 没 reference 它 —— 死配置。
- `vite.config.ts` 没设 `build.sourcemap` —— 线上 stack trace 不可读，配 `"hidden"` 既不外泄又可上传到 sourcemap 服务。
- **依赖年龄**：
  - `rusqlite = "0.31"`（差两个小版本，bundled SQLite 3.45 已过支持）
  - `notify = "6.0"`（差两个大版本，已知 FSEvents bug）
  - **`rllm = "1.1"` 已停止维护**（上游 archived），且承担密钥处理 + SSE 解析 —— 强烈建议自维护或换 `eventsource-stream + reqwest` 直写（约 500 行可替）。
- 锁文件 reproducibility 没问题，但 `package.json` 无 `"engines"`、无 `.nvmrc`、无 Renovate；Tiptap minor 频繁破坏 schema，应当 pin exact 版本。
- `tsconfig.json` 未启用 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` —— IPC payload 缺字段会静默成 `undefined`。

### 可观测性

- [`lib.rs:346-348`](../app/flowix-desktop/src/lib.rs) 的 `tracing_subscriber::fmt()` 写 stderr —— Windows 发布构建是 `windows_subsystem = "windows"`，stderr 根本无处可读。**用户没法给你日志。**
- Subscriber 初始化在 `tauri::Builder` 中段，**前面所有 `tracing::warn!`（含 `migrate_legacy_woop_dirs`）全部丢失**。
- 无日志文件、无轮换、无 PII 脱敏（请求 body 在 DEBUG 级别整段记录）。
- 无崩溃收集；macOS 走系统 DiagnosticReports 但没 `BUGS_URL`；Windows 干脆什么都没。
- 前端 `ErrorBoundary` 没 Sentry / 没自定义 `app-error` IPC 上报。

### 测试覆盖

- `app/flowix-desktop` **零** `#[cfg(test)]`（grep 验证）—— 19k LoC 的 watcher / agent / providers / open_target 全无单元测试。
- `app/flowix-cli` 零测试。
- `flowix-core/memo_file/tests.rs` 是唯一 Rust 测试源（覆盖较完整），但**缺**：原子写、并发同 id 写、崩溃恢复、对抗性 YAML、大文件、Unicode 文件名、`notebook.json` 损坏恢复、Watcher 集成。
- 前端 `package.json` 装了 `jsdom` 但**没装** vitest/jest/RTL，0 测试文件。

### 国际化

- 全栈硬编码中文，无 i18n 层；`user-settings-store` 里 `preferredLanguage` 只用于显示，没真正切换。出海/开源用户接入门槛高。

### a11y

- [`Dialog`](../app/flowix-web/components/ui/dialog.tsx) 无 `aria-modal`、无 focus trap、无 focus restore；删除/确认按钮无 initial focus。
- 列表后台运行指示仅靠 `bg-blue-500 animate-pulse`（[`chat-history.tsx:64`](../app/flowix-web/windows/main/agent-panel/chat-history.tsx)），无文本/`aria-live` —— 屏幕阅读用户无感知。
- MemoCard 颜色 dot 被 `aria-hidden="true"` 隐藏，可颜色本身在产品里语义化使用。

### 杂项

- `eprintln!` 散落多处（[`commands/memo.rs:148, 292`](../app/flowix-desktop/src/commands/memo.rs)、[`commands/file.rs:122`](../app/flowix-desktop/src/commands/file.rs) 等）—— Windows 上无人可见，且形成 "猜路径存在性" 侧信道（命中/未命中产生差异化日志）。
- `app/flowix-web/lib/store/user-settings-store.ts:114-115` 用模块级 `flushTimer/pendingSettings`，主窗口 + 偏好窗口同时打开时跨窗口竞态。
- `slash-menu.tsx:23-27` 用模块级单例菜单 —— 未来多编辑器实例就会撞车。
- [`commands/window.rs:9-58`](../app/flowix-desktop/src/commands/window.rs) `tab: Option<String>` 直接拼到 `eval('window.location.hash = ...')` —— 同信任域内的 self-XSS，建议 whitelist 枚举。
- [`prompt/tools.rs:11`](../app/flowix-desktop/src/prompt/tools.rs) 在 system prompt 里告诉模型有 `bash` 工具，但实际 `tools/mod.rs:156` 直接 disable —— 每次模型调用都浪费一个 turn 撞墙。

---

## ✅ 已经做得不错（请保留）

- **`flowix-core` 零 Tauri 依赖**，依赖树极薄（`serde + chrono + walkdir + regex + tracing + nanoid + dunce`），CLI/desktop 共享得很干净 —— 这是整个工程最舒服的一道接缝。
- **`dunce` 在 Windows 路径处理上用得正确**，多数 Tauri 项目都翻车的地方它对了。
- **`tempfile + rename` 原子写已落地**于 `index.json`、`memo.json`、`ai_config.json`，模式现成、抽出来给 `.md` 用即可。
- **`Cargo.lock` 已提交**，构建可复现。
- **`#[cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`** 正确去掉 release 控制台窗口。
- **`tauri-plugin-single-instance` + deep-link** 三条路径（argv / second instance / `on_open_url`）都汇到同一 `parse_open_target`，统一性好。
- **不存在 `import.meta.env.VITE_*` / `.env`** —— 没有把任何密钥编进前端 bundle。
- Agent ReAct 循环里的**层叠保护**（`STUCK_THRESHOLD=5`、`MAX_LLM_RECOVERY_RETRIES=2`、`max_cycles=100`、`IsLoadingGuard` RAII drop）设计正确。
- Agent **并行 tool_call 用 `BTreeMap<usize>` keyed on `index`** 加全套单元测试 ([`openai_compatible.rs:894-995`](../app/flowix-desktop/src/providers/openai_compatible.rs)) —— 是少数有测试的部分。
- `path_scope.rs::path_is_inside` **canonicalize-then-prefix** 写法本身没问题，问题在于很多调用点跳过它（直接 `starts_with`）。
- `clear_all_loading` 启动时清理上次崩溃残留的 `is_loading=1` —— 注意到了崩溃恢复细节。
- **`flowix-cli` sidecar 没有任何 `Command::new`**，desktop 也没 spawn 它（grep 验证），命令注入面 = 0。

---

## 📋 推荐执行顺序（ROI 排序）

| 优先级 | 工作 | 涉及文件 | 估时 |
|---|---|---|---|
| P0-1 | API key 迁移到 OS keychain + IPC 改返回 mask | `user_config.rs`, `commands/settings.rs`, `agent-panel/agent-root.tsx` | 1d |
| P0-2 | 收紧 CSP `connect-src` 到 3 个固定 LLM host + `assetProtocol.scope` | `tauri.conf.json` | 1h |
| P0-3 | AI 文件工具沙箱：硬编码 notebook root allowlist | `providers/tools/{mod,filesystem}.rs` | 0.5d |
| P0-4 | `write_export_file` 加后端 scope guard | `commands/dialog.rs` | 1h |
| P0-5 | 关闭 `devtools: true`；`open_devtools()` 仅 cfg(debug) | `tauri.conf.json` | 5min |
| P0-6 | `atomic_write_md` 替换所有 `.md` 的 `fs::write` | `flowix-core/memo_file/ops.rs`, `commands/memo.rs` | 0.5d |
| P0-7 | AI 工具 `fs::*` → `tokio::fs::*` 或 `spawn_blocking` + 文件大小/时长上限 | `providers/tools/filesystem.rs`, `agent.rs:1483` | 0.5d |
| P0-8 | 增加 GH Actions：PR build + release matrix；sidecar 签名脚本 | `.github/workflows/`, `scripts/sign-cli.sh` | 1d |
| P1 | 抽 `lock_recovery` helper 替换所有 `.unwrap()` of `RwLock`（40 处） | `commands/*.rs` | 1h（一次性 sed） |
| P1 | 流式包 `tokio::time::timeout` + 429/5xx 退避重试 + SSE 改字节缓冲 | `providers/openai_compatible.rs` | 1d |
| P1 | `[profile.release] lto/codegen-units/strip` | `app/Cargo.toml` | 5min |
| P1 | 把 `tracing` 落盘 + 启动期 panic hook | `lib.rs`, `main.rs` | 0.5d |
| P1 | `notebook.json` 原子写 + `index.json` 损坏自愈 | `flowix-core/memo_file/{notebook,index_store}.rs` | 0.5d |
| P1 | Watcher 自写标记前置；外部修改时给 search 索引补 `try_index_upsert` | `agent.rs:1455`, `watcher/processor.rs` | 0.5d |
| P1 | `MemoCard` 加 `React.memo`，store 改 slice selector，列表上 `react-virtual` | `main-layout.tsx`, `memo-list.tsx`, `memo-card1.tsx` | 0.5d |
| P1 | 删除死依赖（`html2pdf.js / mammoth / pdf-parse`），`react-syntax-highlighter` 改 `React.lazy` | `package.json`, `markdown-renderer.tsx` | 1h |
| P2 | 加 `vitest` + 一组关键路径 smoke test；`cargo audit / deny` 接入 CI | 全栈 | 1-2d |
| P2 | `bundle.targets` 按 host 划分；`tauri-plugin-updater` 接入；`bundle.sourcemap: "hidden"` | `tauri.conf.json`, `vite.config.ts` | 0.5d |
| P2 | 把 `rllm` 自维护或换 `reqwest + eventsource-stream` | `providers/openai_compatible.rs` | 1-2d |

---

## 一句话总结

**产品形态、工程分层、设计意图都很专业**（`flowix-core` 干净分层、watcher 流水线分阶段、agent ReAct 多重护栏），**但生产级别的边界硬伤集中在三块**：

1. **机密 & 沙箱** —— API key 明文回前端，AI 工具可访问 "曾授权过" 的所有目录，CSP 给了 `unsafe-eval + https:` 全开通配；
2. **数据持久层鲁棒性** —— 用户正文 `.md` 非原子写，无 OCC，无回收站，索引损坏无自愈；
3. **可发布性 & 可观测性** —— 无 CI、无签名、无更新器、无落盘日志、无崩溃上报，`devtools` 在 release 包里大开。

只要把上面 **P0 九条**收掉，这个项目就具备分发给真实用户的资格；P1 是规模化到几千用户后会陆续暴雷的部分，建议在 1.0 之前清完。
