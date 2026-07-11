# Flowix Memo

<a href="README.md" style="color: inherit">中文</a> · <a href="README.en.md" style="color: inherit">English</a>

[![支持平台](https://img.shields.io/badge/Platform-macOS%20|%20Windows-0078D4)](https://github.com/text2future/flowix/releases)
[![版本号](https://img.shields.io/github/v/release/text2future/flowix)](https://github.com/text2future/flowix/releases)

![Flowix](./docs/images/readme-banner.png)


Flowix 是一款本地优先的桌面笔记应用。

和传统的 Notion、Obsidian 等不同，Flowix 聚焦在管理 AI 输入与 AI 对话，把人和 AI 的写作都装进同一份文档。

Flowix 将文档视为最高优先级元素：传统产品用 AI 管理文档，而 Flowix 通过文档管理 AI。AI 的行为被记录下来，人的写作与 AI 生成的内容都能被有效管理。
---

1. **适合长期沉淀资料**

   笔记以本地 Markdown 文件保存。你能在系统文件夹里直接看到这些 `.md` 文件，也可以用自己的同步盘、备份工具或版本管理方式来保存它们。
   这种方式的好处是，内容不会被锁在某个专有云服务里；以后即使换工具，笔记仍然是普通 Markdown 文件，可以被其他编辑器继续读取。

2. **适合按项目管理上下文**

   用笔记本来组织内容。一个笔记本就是一个本地文件夹，你可以把工作、研究、客户项目、日记或资料库分别放在不同笔记本里。
   切换笔记本时，Flowix 会切换当前上下文。这样在写某个项目时，不会被其他项目的笔记干扰；调用 AI 代理时，也更容易只提供相关资料。

3. **适合和 AI 一起处理笔记**

   支持在文档里调用内置 AI Agent，也可以连接 Claude Code、Codex、Hermes 等本地 CLI 代理。代理可以读取你指定的笔记或文件夹，然后帮你做总结、改写、问答、计划拆解和代码相关任务。
   关键点是，你可以控制代理能看到什么——只给它当前笔记、某个文件夹或整个笔记本，取决于这次任务需要多少上下文。

4. **适合轻量写作和结构化管理并存**

   日常记录时，你可以把 Flowix 当成普通 Markdown 编辑器，直接写标题、段落和清单；需要管理时，再给笔记加标签或属性。
   标签写在正文里，比如 `#idea` 或 `#meeting`；属性写在 Markdown frontmatter 里，例如状态、类型、来源和关键词。这些信息会跟着文件一起保存，也能被其他兼容 Markdown 的工具读取。

---

### 🤖 AI 能力

Flowix 内置 AI 代理，**不锁死单一服务商**，也不把 AI 对话做成一次性的聊天记录。

- **多 Provider** — OpenAI, Anthropic, DeepSeek 等按需切换
- **多 Agent** — Claude Code, Codex, Hermes 在文档内 `/` 进行使用

![AI Agent](./docs/images/readme-agent.png)


---
**环境要求**：Node.js 20+、Rust 1.75+、macOS 14+ 或 Windows 10+。
