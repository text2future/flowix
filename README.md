<a href="README.md">简体中文</a> · <a href="docs/README.en.md">English</a> · <a href="https://flowix-memo.com/roadmap">Roadmap</a> · <a href="https://flowix-memo.com/updates">What's New</a>

# Flowix Memo

[![支持平台](https://img.shields.io/badge/Platform-macOS%20|%20Windows-0078D4)](https://github.com/text2future/flowix/releases)
[![最新版本](https://img.shields.io/github/v/release/text2future/flowix)](https://github.com/text2future/flowix/releases)

![Flowix Memo](./docs/images/readme-banner.png)

**Flowix Memo 是面向 AI Agent 的本地文档空间。**

它将日常笔记、任务需求、参考资料、Agent 对话与产出放进同一套 Markdown 工作流，让上下文可以长期积累、持续编辑和反复使用。

Flowix Memo 主要帮助解决这些常见问题：

- Prompt 和任务说明散落各处，难以管理
- Agent 缺少稳定上下文，反复犯同样的错误
- 对话中跑通的流程和有价值的产出，难以沉淀和复用

在 Flowix Memo 中，一篇文档既可以是笔记，也可以是 Agent 的任务说明、长期记忆和工作结果。AI 协作不再止于一次性聊天，而是逐渐积累为可以复查、编辑和再次调用的知识。

## 你可以用它做什么

### 记录日常笔记，沉淀 Agent 工作

记录读书笔记、旅行计划、工作日志和日常随笔，也可以把需求、资料与参考链接写进文档，让 Agent 基于明确的上下文进行总结、改写、问答、任务拆解或代码编写。

Agent 的输出可以继续写回文档，成为下一次工作的输入。

### 用笔记本组织项目上下文

一个笔记本就是一个本地文件夹。你可以把工作、研究、客户项目、日记、资料库或代码项目分别放在不同笔记本中。

切换笔记本，也是在切换默认工作上下文。这样既能减少不同项目之间的信息干扰，也更容易只向 Agent 提供完成任务所需的资料。

### 让内容长期保留在本地

笔记以普通 Markdown 文件保存在你的磁盘中，可以直接用其他编辑器打开，也可以交给自己的同步盘、备份工具或版本管理系统。

内容不会被锁在专有云服务里。即使以后更换工具，你的文档依然可读、可迁移、可继续使用。

### 在文档中调用不同的 Agent

Flowix Memo 支持内置 AI Agent，也可以连接 Claude Code、Codex、Hermes 等本地 CLI Agent。你可以根据任务控制 Agent 能看到的范围，例如当前笔记、某个文件夹、整个笔记本或项目目录。

上下文越明确，Agent 的输出越稳定；过程被记录下来后，也更容易复盘、修改和继续推进。

内置 Agent 采用 BYOK（自备 API Key）模式。只有当你主动发起模型请求时，所选上下文才会发送给你配置的模型服务商。

### 连接外部 Agent 工作流

Flowix CLI 可供本地 Agent 执行非交互式笔记操作；
MCP 则让支持 MCP 的外部 Agent 客户端读取、检索和更新 Flowix 文档。

对于外部 Agent 客户端，推荐优先使用 MCP。配置方式与工具说明请查看[帮助文档](https://flowix-memo.com/docs/)。

## 核心能力

**Markdown 与本地文件夹**：数据可直接访问、备份、迁移或版本管理<br>
**标签与属性**：通过正文标签和 YAML Frontmatter 组织结构化信息<br>
**BYOK 与多 Provider**：支持 OpenAI、Anthropic、DeepSeek 等模型服务<br>
**内置与本地 Agent**：在文档中使用内置 Agent、Claude Code、Codex 或 Hermes<br>
**CLI 与 MCP**：将文档接入本地或外部 Agent 工作流<br>
**多窗口与多页签**：将笔记拆分到子窗口，并在窗口之间移动页签

![AI Agent](./docs/images/readme-agent.png)

## 快速开始

1. 从 [Releases](https://github.com/text2future/flowix/releases) 下载并安装 Flowix Memo。
2. 新建一个本地文件夹，或注册已有文件夹作为笔记本。
3. 创建文档，写下任务背景、参考资料、目标和约束。
4. 在文档中调用 Agent，或通过标签与属性继续组织内容。

## 本地开发

```bash
git clone https://github.com/text2future/flowix.git
cd flowix
npm install

npm run tauri dev
npm run dev
npm run tauri build
```

开发环境需要 Node.js 20+、Rust 1.75+、Tauri v2；桌面应用支持 macOS 14+ 和 Windows 10+。

## 更多信息

欢迎提交 Issue 或 Pull Request 参与改进。

- 官网：[https://flowix-memo.com/](https://flowix-memo.com/)
- 帮助文档：[https://flowix-memo.com/docs/](https://flowix-memo.com/docs/)
- GitHub：[https://github.com/text2future/flowix](https://github.com/text2future/flowix)
