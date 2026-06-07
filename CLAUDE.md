# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Flowix 是一款桌面笔记应用（Tauri 2 + Rust 后端，React 19 + TypeScript + Tiptap 前端），内置 AI 代理（`rllm` crate；OpenAI / Anthropic / DeepSeek 全部走 `openai_compatible` provider 适配）。

## 命令

`package.json` 位于仓库根目录（`app/` 下只有 `backend/` 和 `frontend/` 两个子工程，没有独立 `package.json`），所有 npm 命令都在根目录执行：

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
npm run tauri dev     # 完整应用开发
npm run dev           # 仅前端 (localhost:1420)
npm run tauri build   # 生产构建
```

若端口 1420 被占用：`pkill -f "node.*vite" 2>/dev/null` 或 `lsof -i :1420 -t | xargs kill -9`

首次运行可能需要：`sudo xcode-select -r`

### Rust 测试

后端有零散 `#[cfg(test)]` 单元测试（如 `app/backend/src/memo_events.rs`、`app/backend/src/agent.rs`）。运行单个模块：

```bash
cd app/backend
cargo test memo_events::tests         # 跑某模块的全部测试
cargo test memo_events::tests::test_xxx  # 跑单个测试
cargo test --lib                      # 跑全部
```

## 架构

### 窗口拓扑（前端）

两个 Tauri 窗口共用同一份前端 bundle。入口 `app/frontend/App.tsx` 按 `window.location.hash` 分发：

- `#preferences/<tab>` → `windows/preferences/preferences-view.tsx`（`tab` 可选 `general`/`format`/`theme`/`agent`/`shortcuts`/`connections`/`history`）
- 其他 → `windows/main/main-layout.tsx`（三栏：MemoList | MemoDetail | AgentPanel）

`windows/<window>/` 是**自包含**窗口：layout、组件、专属逻辑各管各的。`sections/`（`preferences` 下）的设置 tab 内容被命令面板和偏好设置窗口共用，是**单一真源**。

`components/` 只放**跨窗口**共享资源：`mdeditor/`（Tiptap）、`srceditor/`（Monaco）、`ui/`（shadcn）、`icons/`、`loading/`、`error-boundary.tsx`、`windows-titlebar-controls.tsx`、`ui/command.tsx`（shadcn Command 底层）。**所有 hooks 集中在 `lib/hooks/`**，不在 `windows/<window>/hooks/` 下维护镜像。

### 三栏布局

`app/frontend/windows/main/main-layout.tsx`：

- 左 MemoList（默认 320px，可拖 150–500）
- 中 DocumentContainer（Tiptap / Monaco 切换）
- 右 AgentChatRoot（可拖 200–600）
- 底 StatusBar

宽度 < 1100px 时打开 AgentPanel 会自动收 MemoList 释放空间。外部 `.md` 文件拖入 / 命令行参数 / 关联文件打开 → 走 "external markdown" 模式，**不进** `list.json`，用户可手动 save 成正式 memo。

### 后端（`app/backend/src/`）

`lib.rs::run()` 是 Tauri 启动入口，做四件事：(1) 一次性 `migrate_legacy_woop_dirs()` 把 WoopMemo 时代数据目录搬过来（`~/.woop/` → `~/.flowix/`，`<data_dir>/woopmemo/` → `<data_dir>/flowix/`，`Documents/woop notebook/` → `Documents/flowix/`，并重写 `notebook.json` 里的 path 字段）；(2) 初始化 `UserConfigStore` / `GlobalMetaData` / `MemoFile` / `MemoIndex` / `ThreadManager` / `AgentManager` 六个共享服务；(3) 启动 `MemoWatcher`（`notify` crate）监听当前 notebook 目录，磁盘变更转 `memo-event` 推到前端；(4) 注册所有 IPC 命令到 `tauri::generate_handler!`。

IPC 命令按**业务域**拆到 `commands/<domain>.rs`（memo / tag / notebook / file / dialog / agent / thread / window / settings / kv / helpers），旧的单文件 `commands.rs` 已删除。`AppState` 在 `commands/mod.rs` 定义，是所有 IPC 命令的共享状态（`user_config` / `memo_file` / `thread_manager` 用 `Arc` 共享，其余 `search` / `global_meta_data` 直接持引用）。`memo_file.rs` 也已拆成 `memo_file/` 模块（`mod.rs` + `content.rs` / `frontmatter.rs` / `list_store.rs` / `notebook.rs` / `types.rs` / `derivation.rs` / `registration.rs` / `time.rs`）。

其他模块职责：
- `providers/openai_compatible.rs` — 统一 LLM adapter；`providers/tools/{filesystem,notebook}.rs` 是 Agent 工具调用。
- `prompt/{base,behavior,safety,tools}.rs` — Agent system prompt 拼装。
- `search.rs` — 当前 notebook 的内存倒排索引（bigram tokenizer），切换 notebook 时 rebuild，写命令增量 upsert/remove。
- `path_scope.rs` — Agent 工具的路径白名单。
- `fs_watcher.rs` + `memo_events.rs` — 文件监听 + 事件总线。

### 前端（`app/frontend/`）

- `App.tsx` — 入口；按 hash 路由；顶层挂 `useUserSettings` / `useApplyFontSettings` / `useMemoEvents`（主窗口 + 偏好设置窗口都会 mount，跨窗口同步自然成立）。
- `lib/tauri/client.ts` — IPC 封装，对外暴露 `preferences` / `aiConfig` / `settings` / `memos` / `tags` / `notebooks` / `files` / `dialogs` / `windows` / `agent` 命名空间；`agent` 还提供 `listenToAgentStream` / `stopListeningToAgentStream`。
- `lib/store/` — Zustand stores（`memo-store` / `chat-store` / `user-settings-store` / `settings-store` / `document-store` / `tag-store`），全部走 `useXxxStore` 工厂，跨窗口共享同一实例。
- `lib/hooks/` — 全部 hooks 集中（注释明确反对 `windows/<window>/hooks/` 镜像）；`useMemoEvents` 是后端 `memo-event` 事件总线的前端单订阅者。
- `lib/theme/` — 主题纯函数 + React Provider；详见下文"主题与首屏防闪"。
- `windows/main/` — 主窗口（`main-layout.tsx` + `memo-pane/` + `document-pane/` + `agent-panel/` + `status-bar/` + `menu-board.tsx`（Cmd+K）+ `global-search-command.tsx`）。
- `windows/preferences/` — 偏好设置窗口（`preferences-view.tsx` + 平台相关 titlebar + `sections/` tab 内容 + `primitives.tsx` + `types.ts`）。
- `components/` — 跨窗口共享资源（见上）。
- `lib/` — 业务工具（`hooks/` / `store/` / `tauri/` / `theme/` / `constants.ts` / `export.ts` / `path.ts` / `utils.ts` / `toast.tsx` / `message/`）。
- `types/` — 共享类型（`memo.ts` / `agent.ts` / `index.ts` / `mermaid.d.ts`）。
- `css/` — 全局 + `theme/{light,dark,rock}.css`。
- `assets/` — `product-logo.png` / `empty-memo.png` 等。

### 数据流

1. 前端通过 `lib/tauri/client.ts` 的命名空间（`memos.xxx()` / `agent.listenToAgentStream()`）调用 Tauri IPC
2. Rust 后端处理命令，写 `~/.flowix/*.json` 或 `~/Documents/flowix/<notebook>/.metadata/*.json` + `.md`
3. 返回 JSON，前端更新 Zustand store
4. 写操作完成后，后端 `emit("memo-event", { kind, memo, source })` → 前端 `useMemoEvents` 单订阅 → `memo-store.handleMemo{Created,Updated,Deleted}` → store 触发 `triggerRefresh` 让 UI 自动响应
5. UI 自动响应 store 变化

### 主题与首屏防闪

主题真源是 `~/.flowix/preference.json`（Tauri IPC），但 IPC 是 async，等 React mount + useEffect 跑完时首帧已经画完，深色模式会闪一帧白。解决方案：

- `public/theme-boot.js`（**不是** inline script，因为 Tauri CSP `script-src 'self' 'unsafe-eval'` 不含 `unsafe-inline`）在 CSS paint 之前读 `localStorage['flowix-theme']` 写 `data-theme`
- `lib/theme/apply.ts::applyTheme` 是纯函数，主题解析后同步写 localStorage（key: `flowix-theme`）— 命中失败回退 `prefers-color-scheme`
- `lib/theme/provider.tsx` 顶层挂 `ThemeProvider` + `useApplyTheme` 监听系统主题变化

修改主题相关代码时，这三处必须同步：boot script、lib/theme、css/theme/*.css。

### 数据布局

- `~/.flowix/preference.json` — UI 设置（个人化 / 格式 / 主题），原子写（tmp + fsync + rename, 0o600）
- `~/.flowix/ai_config.json` — AI 模型配置，原子写
- `~/.flowix/global_meta_data.json` — 扩展 KV（notebook tag 顺序 / 隐藏状态等无 schema 数据），替代旧 SQLite `app.db`
- `~/.flowix/notebook.json` — 笔记本配置列表（path / 默认笔记本 / 创建时间）
- `~/Documents/flowix/<notebook>/.metadata/list.json` — 该笔记本下全部 memo 的索引（`{ id, filename, preview, tags, todos, createdAt, updatedAt, favorited, icon, path }`）
- `~/Documents/flowix/<notebook>/.metadata/tag.json` — tag 定义
- `~/Documents/flowix/<notebook>/<title>-<id>.md` — 备忘录文件，YAML frontmatter + markdown

### AI 流式响应

`commands/agent::chat_with_agent_stream` 通过 Tauri 事件 `agent-chunk` 推送流式响应；`commands/agent::stop_agent_stream` 终止。前端 `agent.listenToAgentStream` / `stopListeningToAgentStream` 配对使用。

## 关键模式

- **窗口路由**：`#preferences/<tab>` → PreferencesView；其他 → MainLayout。设置类 hooks（`useUserSettings` / `useApplyTheme` / `useApplyFontSettings`）在 `App.tsx` 顶层挂载，两侧即时同步。
- **跨窗口同步**：`user_config` 写入后后端 emit `user-config-changed` 事件 → `App.tsx` 监听后 `loadInitial()`；`memo` 变更走 `memo-event` → `useMemoEvents`。
- **路径参数**：URL `?memoWindowId=` 可打开独立窗口（参见 `app/frontend/App.tsx`）。
- **文件监听**：前端 `chokidar` / Rust `notify` crate。
- **首屏防闪**：外部 `theme-boot.js` 同步读 localStorage 写 `data-theme`（不能用 inline script，CSP 不允许）。
- **跨窗口对话框触发**：用 `window.dispatchEvent(new CustomEvent('flowix:xxx', { detail }))` 而不把 state lift 到 MainLayout（参见 `flowix:open-edit-notebook` / `flowix:request-delete-memo`）。

## 其他

- **图标资源刷新**：`scripts/gen-icon.mjs` 从 `app/frontend/assets/logo.svg` 生成 `_source.png` → 喂给 `npx tauri icon` 重新生成所有平台图标。一次性脚本，跑完可删。
- **CSP**：`script-src 'self' 'unsafe-eval'`、`style-src 'self' 'unsafe-inline'`、`img-src` / `media-src` 含 `asset:` 与 `http(s)://asset.localhost`、`connect-src` 含 `ipc:` `http(s)://ipc.localhost`。改前端加载方式时先核对 `app/backend/tauri.conf.json`。

## Git 操作

远程仓库：`git@github.com:aicollaborate/flowix.git`

```bash
# 首次推送（远程为空）
git init
git remote add origin git@github.com:aicollaborate/flowix.git
git add -A && git commit -m "Initial commit"
git push -u origin main

# 远程地址变更
git remote set-url origin git@github.com:aicollaborate/flowix.git

# 强制覆盖远程（完全替换远程分支，远程有本地无的文件会被删除）
git push -f origin main
```

## Rules

- 在非常确信情况下再进行代码修改
- 保持专业架构设计，不写垃圾代码
