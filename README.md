English | **简体中文**

&nbsp;

# 你的笔记，  
AI 的记忆。

**本地 Markdown 笔记本，让你的写作无缝成为 Agent 可以持续使用的上下文。**

Markdown · 开源 · 多 Agent · MCP 与 CLI

**立即下载** · **官网** · **文档**

---

&nbsp;

## Flowix 让笔记成为持续工作的记忆

用 Markdown 记录内容，把需要的上下文交给 Agent，再将结果写回同一篇笔记，方便检查、修改和下次继续使用。

&nbsp;

---

## 让工作持续推进

把产品、开发、研究和个人知识放在一起，让 Agent 不必每次从头开始。

<!-- flowix:table {"version":1,"columns":[{"width":271},{"width":271}]} -->
| 场景       | 说明                          |
| -------- | --------------------------- |
| **产品工作** | 集中管理需求、反馈和决策，让产品文档保持最新。     |
| **软件开发** | 保存项目背景和约束，让编码 Agent 接着推进。   |
| **课题研究** | 将资料、分析和结论放在一起，方便追溯和复用。      |
| **个人知识** | 让笔记、计划和个人偏好成为 Agent 可用的上下文。 |


&nbsp;

---

## 让不同 Agent 使用同一份记忆

你可以在 Flowix 内使用 Agent，也可以连接 **Codex**、**Claude Code**、**OpenCode**、**Hermes** 及其他 MCP 或 CLI 工具，让它们基于同一套笔记和上下文工作。

&nbsp;

---

## 加入 Flowix 社群

扫描下方二维码加入交流群，一起交流和讨论 Flowix。

&nbsp;

---

## dsh-flowix-memory 插件

[dsh-flowix-memory](dsh-flowix-memory/README.md) 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，通过捆绑的 `flowix-cli` MCP server 把任何 Harness Agent 连接到你的**本地 Flowix 笔记**：安装后 Agent 获得 `mcp__flowix__memo` 工具，可搜索、读取、创建和编辑 Flowix 笔记（包括思维导图）。

从 flowix-main checkout 安装到 `flowix` Harness profile（尚未发布到 npm）。对于其他 DSH 客户端，`flowix` 只是一个普通的自定义 profile 名称：

```sh
dsh plugin --profile flowix add ./dsh-flowix-memory
```

需要 `flowix` CLI 位于 `PATH`（或设置 `FLOWIX_CLI_PATH`），并可访问你的笔记数据（`~/.flowix`）。详见[插件 README](dsh-flowix-memory/README.md)。

## 通过 CLI 传递 Markdown

向 `create` 和 `write` 传递 Markdown 正文时，推荐使用 UTF-8 文件，尤其是在 Windows PowerShell 5.1 中。这样可以避免 stdin 管道编码导致中文内容损坏。支持带 BOM 和不带 BOM 的 UTF-8 文件。

```powershell
flowix create <notebook> --file body.md --json
flowix write <id> --file body.md --json
```

在 Windows 上，未指定输入方式时 CLI 会拒绝隐式读取 stdin，以避免 PowerShell 5.1 的 `$OutputEncoding` 损坏中文；已确认 stdin 为 UTF-8 时请显式加 `--stdin`：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 body.md | flowix create <notebook> --stdin --json
```

`--file` 与 `--stdin` 互斥。`--file` 会直接按 UTF-8 读取；文件不存在、无法读取或不是有效 UTF-8 时，CLI 会返回错误。使用 `--json` 时错误也会以 `{ok:false,error:{code,message}}` 输出。

---

## 笔记留在本地，由你掌控

Flowix 将笔记保存为本地 Markdown 文件。你决定 Agent 能看到什么，也可以自由选择同步和备份方式。

- **保存在本地** — 笔记是普通 Markdown 文件，可以用其他应用打开和编辑。
- **按需连接 Agent** — 使用 Codex、Claude Code、OpenCode 等 Agent 时，只提供你主动选择的内容。
- **自由同步和备份** — 继续使用你熟悉的同步、备份或版本管理工具。

---

## 产品预览

<!-- flowix:table {"version":1,"columns":[{"width":271},{"width":271}]} -->
|                            |                         |
| -------------------------- | ----------------------- |
| &nbsp; *笔记列表与标签组织*         | &nbsp; *笔记详情与 Agent 预设* |
| &nbsp; *Agent 模型选择*        | &nbsp; *全文与文件搜索*        |
| &nbsp; *Provider 与 MCP 配置* | &nbsp; *代码文件浏览与编辑*      |


---

## 快速开始

1. 从 [官网](https://flowix-memo.com/) 下载并安装 Flowix。
2. 新建一个本地文件夹，或将已有文件夹注册为笔记本。
3. 创建一篇文档，记录任务背景、参考资料、目标与约束。
4. 在文档内调用 Agent，或继续用标签与属性组织内容。

## 本地开发

```bash
git clone https://github.com/text2future/flowix.git
cd flowix
npm install

npm run tauri:dev
npm run tauri:build:prod
```

单独运行 `npm run dev` 只启动 Vite 前端，不会启动 Tauri 桌面后端。

桌面开发版 `npm run tauri:dev` 默认连接 `https://cloud.flowix.cc`。在「偏好设置 → 开发 → 环境配置」中选择 Staging 或 Prod，Flowix 会重启以应用切换。首次启动默认使用 Prod；已保存的界面选择优先于构建默认值；`--cloud-env=staging|prod` 设置默认值，仅在尚未保存界面选择时生效：

```bash
npm run tauri:dev -- --cloud-env=staging
npm run tauri:dev -- --cloud-env=prod
```

`npm run tauri:dev:pi` 和 `npm run tauri:dev:win` 也接受该参数。正式包 `npm run tauri:build:prod` 始终连接 `https://cloud.flowix.cc`，不会显示环境下拉。单独运行 `npm run dev` 只启动 Vite 前端，不会启动桌面端 Cloud 同步。

开发环境要求 Node.js 20+、Rust 1.75+ 与 Tauri v2；桌面应用支持 macOS 14+ 与 Windows 10+。

## 许可协议

Flowix 基于 [GNU Affero 通用公共许可证第 3 版](LICENSE) 开源（AGPL-3.0-only）。