# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Flowix 是一款桌面笔记应用（**Tauri 2 + Rust 后端，React 19 + TS + Tiptap 前端**），内置 AI 代理（`rllm` v1.1，OpenAI / Anthropic / DeepSeek 全部走 `openai_compatible` provider）。


## 命令

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
npm run tauri dev         # 完整应用开发（Tauri + Vite + Rust）
npm run dev               # 仅前端 (localhost:1420)
npm run tauri build       # 生产构建
npm run cli:build         # 编 CLI sidecar 到 app/flowix-desktop/binaries/（当前 host）
npm run cli:build:all     # CI 用：三平台（linux / macOS ×2 / windows）全编
pkill -f "node.*vite" 2>/dev/null   # 端口冲突时
sudo xcode-select -r                  # 首次运行
```

Rust 测试（在 `app/` 目录跑）：

```bash
cd app
cargo test -p flowix-core <module>::tests           # 跑某 crate 某模块
cargo test -p flowix-core <module>::tests::test_xxx # 跑单个
cargo test --workspace --lib                         # 跑全部
```

## Dev / Prod 并存打包

通过差异化 Tauri 配置，让 dev 版与已安装的生产版同时运行：

- **dev**：`npm run tauri:dev` → `app/flowix-desktop/tauri.conf.dev.json` → bundle ID `com.flowix.app.dev` / `Flowix Dev`
- **生产**：`npm run tauri:build:production` → `tauri.conf.json` + 平台覆盖层 + 签名覆盖层 → 平台专用 `tauri.*.production.local.json` → bundle ID `com.flowix.app` / `Flowix`
- **默认 build**：`npm run tauri:build` → 默认 `tauri.conf.json` → 生产身份（无签名，便于本地试装）

`tauri:dev` 通过 `--config` 指向独立配置，**不要**改 `tauri.conf.json` 的 `identifier` / `productName` / `mainBinaryName` / `bundle.macOS.bundleName` —— 这四个字段是生产身份的锚点。`tauri.conf.production.json` 作为覆盖层被 `tauri build --config` 深合并在 `tauri.conf.json` 之上，因此 dev 配置改动不会污染生产链路。

dev 与生产现使用不同 bundle ID（`com.flowix.app.dev` vs `com.flowix.app`），可同时运行且互不冲突（Tauri `app_data_dir` / `tauri-plugin-single-instance` lock 都按 identifier 派生）。代价：dev 首次运行需要重新授予一次 user-selected folder 授权（TCC 按 identifier 记忆授权），prod 已授予的不会带过来。视觉上仍通过 bundle name / 窗口标题区分（`Flowix Dev` vs `Flowix`）。URL scheme `flowix://` 仍共用，让浏览器深链能落到任一已装实例。

### macOS 本地生产包 ad-hoc 签名

构建 macOS 生产包后，如果没有 Developer ID，也要对 bundle 内 sidecar 和 `.app` 做一次本地 ad-hoc codesign，让 `entitlements.plist` 写进可执行产物；否则 security-scoped bookmarks / user-selected folder 权限相关 entitlement 不会实际生效。

```bash
npm run tauri:build:production

codesign --force --options runtime --sign - \
  --entitlements app/flowix-desktop/entitlements.plist \
  "app/flowix-desktop/target/release/bundle/macos/Flowix.app/Contents/MacOS/flowix-cli"

codesign --force --deep --sign - \
  --entitlements app/flowix-desktop/entitlements.plist \
  "app/flowix-desktop/target/release/bundle/macos/Flowix.app"
```

`--sign -` 是 ad-hoc 签名，只适合本机开发 / 本地试装，不能替代 Developer ID 签名与 notarization。先签 `Contents/MacOS/flowix-cli`，再签外层 `.app`；若实际产物路径不同，以 `target/release/bundle/macos/*.app` 为准。

## Rules

- 在非常确信情况下再进行代码修改
- 保持专业架构设计，不写垃圾代码

## 架构图

```
flowix-main/
├── app/                                  # Rust workspace
│   ├── Cargo.toml                        # workspace 清单
│   │
│   ├── flowix-core/                      # 业务核心（零 Tauri 依赖，CLI + Desktop 共享）
│   │   └── src/
│   │       ├── lib.rs                    # crate 入口
│   │       ├── search.rs                 # 全文搜索
│   │       └── memo_file/                # 笔记存储层
│   │           ├── mod.rs                # 模块入口
│   │           ├── content.rs            # 内容读写
│   │           ├── frontmatter.rs        # 元数据头
│   │           ├── index_store.rs        # 索引存储
│   │           ├── notebook.rs           # 笔记本
│   │           ├── ops.rs                # CRUD
│   │           ├── derivation.rs         # 派生计算
│   │           ├── registration.rs       # 注册管理
│   │           ├── types.rs              # 类型定义
│   │           ├── time.rs               # 时间工具
│   │           └── tests.rs              # 单元测试
│   │
│   ├── flowix-desktop/                   # Tauri 2 桌面壳
│   │   ├── tauri.conf.json               # Tauri 配置
│   │   ├── build.rs                      # 构建脚本
│   │   ├── binaries/                     # CLI sidecar 产物
│   │   └── src/
│   │       ├── main.rs                   # 应用入口
│   │       ├── lib.rs                    # 装配 run()
│   │       ├── agent.rs                  # AI 代理
│   │       ├── agent_access.rs           # 代理鉴权
│   │       ├── threads.rs                # 会话线程
│   │       ├── fs_watcher.rs             # 文件监听
│   │       ├── memo_events.rs            # 笔记事件
│   │       ├── global_meta_data.rs       # 全局元数据
│   │       ├── user_config.rs            # 用户配置
│   │       ├── path_scope.rs             # 路径白名单
│   │       ├── commands/                 # Tauri IPC 命令
│   │       │   ├── memo.rs               # 笔记命令
│   │       │   ├── notebook.rs           # 笔记本命令
│   │       │   ├── agent.rs              # 代理命令
│   │       │   ├── thread.rs             # 线程命令
│   │       │   ├── settings.rs           # 设置命令
│   │       │   ├── tag.rs                # 标签命令
│   │       │   ├── file.rs               # 文件命令
│   │       │   ├── dialog.rs             # 系统对话框
│   │       │   ├── kv.rs                 # KV 存储
│   │       │   └── window.rs             # 窗口控制
│   │       ├── providers/                # LLM provider
│   │       │   ├── openai_compatible.rs  # 统一接入
│   │       │   └── tools/                # 函数工具
│   │       │       ├── filesystem.rs     # 文件工具
│   │       │       └── notebook.rs       # 笔记工具
│   │       ├── watcher/                  # 监听器流水线
│   │       │   ├── dispatcher.rs         # 事件派发
│   │       │   ├── processor.rs          # 事件处理
│   │       │   ├── event.rs              # 事件类型
│   │       │   ├── path.rs               # 路径工具
│   │       │   ├── whitelist.rs          # 路径白名单
│   │       │   └── filter/               # 过滤管线
│   │       │       ├── debouncer.rs      # 防抖
│   │       │       ├── id_dedup.rs       # ID 去重
│   │       │       ├── path_filter.rs    # 路径过滤
│   │       │       └── self_write.rs     # 自写过滤
│   │       ├── prompt/                   # 系统提示词
│   │       │   ├── base.rs               # 基础提示
│   │       │   ├── behavior.rs           # 行为规范
│   │       │   ├── safety.rs             # 安全约束
│   │       │   └── tools.rs              # 工具声明
│   │       └── open_target/              # 跨端链接打开
│   │           ├── parser.rs             # URL 解析
│   │           ├── resolver.rs           # 目标解析
│   │           └── handler.rs            # 跳转处理
│   │
│   ├── flowix-cli/                       # CLI sidecar（Tauri shell 调用）
│   │   └── src/
│   │       ├── main.rs                   # CLI 入口
│   │       ├── lib.rs                    # 子命令派发
│   │       ├── editor.rs                 # 外部编辑器
│   │       ├── store.rs                  # 复用 core
│   │       ├── paths.rs                  # 路径解析
│   │       ├── fmt.rs                    # 输出格式
│   │       └── errors.rs                 # 错误定义
│   │
│   └── flowix-web/                       # React 19 + Vite 前端
│       ├── index.html                    # HTML 入口
│       ├── main.tsx                      # Vite 入口
│       ├── app.tsx                       # 根组件
│       ├── types/                        # 全局类型
│       ├── components/
│       │   ├── editor/                   # Tiptap 富文本
│       │   │   ├── markdown-editor.tsx   # 编辑器壳
│       │   │   ├── extensions/           # Tiptap 扩展
│       │   │   │   ├── slash-menu.tsx    # 斜杠菜单
│       │   │   │   ├── frontmatter.tsx   # 元数据头
│       │   │   │   ├── tag.ts            # 标签节点
│       │   │   │   ├── mermaid-diagram.tsx# Mermaid 图
│       │   │   │   ├── search-replace.ts # 查找替换
│       │   │   │   ├── markdown-link.ts  # 链接节点
│       │   │   │   ├── markdown-paste.ts # 粘贴处理
│       │   │   │   ├── attachment-link/  # 附件嵌入
│       │   │   │   ├── note-reference/   # 笔记互链
│       │   │   │   ├── codeblock-shiki/  # 代码块
│       │   │   │   └── shiki/            # 语法高亮
│       │   │   └── components/           # 浮动菜单
│       │   ├── ui/                       # shadcn 基础组件
│       │   └── error-boundary.tsx        # 错误边界
│       ├── lib/
│       │   ├── store/                    # Zustand 状态层
│       │   │   ├── memo-store.ts         # 笔记状态
│       │   │   ├── document-store.ts     # 文档状态
│       │   │   ├── document-buffer.ts    # 文档缓冲
│       │   │   ├── document-session-service.ts # 会话服务
│       │   │   ├── buffer-registry.ts    # 缓冲注册
│       │   │   ├── save-queue.ts         # 保存队列
│       │   │   ├── chat-store.ts         # 对话状态
│       │   │   ├── settings-store.ts     # 设置状态
│       │   │   ├── user-settings-store.ts# 用户偏好
│       │   │   ├── agent-access-store.ts # 代理状态
│       │   │   └── tag-store.ts          # 标签状态
│       │   ├── tauri/
│       │   │   ├── client.ts             # IPC 封装
│       │   │   └── event-bus.ts          # 事件总线
│       │   ├── hooks/                    # React Hooks
│       │   ├── shortcuts/                # 快捷键系统
│       │   │   ├── registry.ts           # 注册中心
│       │   │   ├── matcher.ts            # 键序匹配
│       │   │   ├── parser.ts             # 组合解析
│       │   │   └── shortcuts-provider.tsx# Provider
│       │   ├── theme/                    # 主题系统
│       │   ├── openByTarget/             # 链接调度
│       │   ├── message/                  # 消息解析
│       │   ├── memo-dispatcher.ts        # 笔记派发
│       │   ├── memo-dispatcher-dedup.ts  # 派发去重
│       │   ├── event-dispatcher.ts       # 事件派发
│       │   ├── export.ts                 # 导出工具
│       │   └── toast.tsx                 # Toast 通知
│       └── windows/
│           ├── main/                     # 主窗口
│           │   ├── main-layout.tsx       # 三栏布局
│           │   ├── menu-board.tsx        # 菜单面板
│           │   ├── global-search-command.tsx # 全局搜索
│           │   ├── agent-panel/          # AI 对话面板
│           │   │   ├── agent-root.tsx    # 面板根
│           │   │   ├── chat-history.tsx  # 历史列表
│           │   │   ├── chat-message.tsx  # 单条消息
│           │   │   ├── agent-inputbox.tsx# 输入框
│           │   │   └── messages/         # 消息渲染
│           │   ├── document-pane/        # 文档面板
│           │   │   ├── document-container.tsx # 文档容器
│           │   │   └── session/          # 文档会话 hooks
│           │   ├── memo-pane/            # 笔记列表
│           │   │   ├── memo-list.tsx     # 列表本体
│           │   │   └── memo-card1.tsx    # 笔记卡片
│           │   ├── status-bar/           # 底部状态栏
│           │   └── drag-overlay/         # 拖拽蒙层
│           └── preferences/              # 偏好窗口
│               ├── preferences-view.tsx  # 偏好主视图
│               └── sections/             # 各分区面板
│
├── scripts/
│   ├── build-cli.sh                      # 编 CLI sidecar
│   └── gen-icon.mjs                      # 生成图标
│
├── vite.config.ts                        # Vite 配置
├── tailwind.config.js                    # Tailwind
├── tsconfig.json                         # TS 配置
└── package.json                          # 前端清单
```

**说明：**
- **`flowix-core`** 是纯 Rust 库，无 Tauri 依赖，被 `flowix-desktop` 与 `flowix-cli` 共享 —— CLI 通过 sidecar 形式打包进 desktop binaries 目录。
- **`flowix-desktop`** 负责 Tauri 装配：commands（IPC）、watcher（文件监听管线）、providers（LLM 调用，统一走 `openai_compatible`）、prompt（系统提示词）、open_target（深链）。
- **`flowix-web`** 单仓双窗口（main + preferences）：state 用 Zustand，编辑器用 Tiptap + Shiki，IPC 走 `lib/tauri/client.ts`。
- 顶层 `skills/`、`dist/`、`node_modules/`、`app/target/` 为产物 / 资源 / 衍生目录，已省略。
