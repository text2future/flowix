# Flowix Memo

<a href="README.md" style="color: inherit">中文</a> · <a href="README.en.md" style="color: inherit">English</a>

[![Platform](https://img.shields.io/badge/Platform-macOS%20|%20Windows-0078D4)](https://github.com/text2future/flowix/releases)
[![Latest Release](https://img.shields.io/github/v/release/text2future/flowix)](https://github.com/text2future/flowix/releases)

![Flowix](./docs/images/readme-banner.png)

### ✨ 简介

Flowix 是一款本地优先的桌面笔记应用。

和传统的 Notion、Obsidian 等不同，Flowix 聚焦在管理 AI 输入与 AI 对话，把人和 AI 的写作都装进同一份文档。

Flowix 将文档视为最高优先级元素：传统产品用 AI 管理文档，而 Flowix 通过文档管理 AI。AI 的行为被记录下来，人的写作与 AI 生成的内容都能被有效管理。

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

### 🏠 本地优先

Flowix 的核心理念是 **Local-First** — 数据优先存在你本地的硬盘上，而不是某个云端服务商的服务器里。

具体做法：

- 📁 **文件就是数据** — 笔记以标准 Markdown + YAML frontmatter 存在 `~/Documents/flowix/<notebook>/` 下，任何编辑器都能打开
- ⚙️ **配置就是文件** — `~/.flowix/` 下是纯 JSON，可读、可改、可脚本化
- 🔓 **没有账号、没有云端** — 没有注册流程，没有用户 ID，没有"先登录才能用"
- 📜 **开源透明** — 代码采用 [CC BY-NC 4.0](LICENSE) 协议
- 🧳 **可携带** — 整个数据目录打个 zip 就能带走到任何机器
- 🕵️ **不留痕** — 没有遥测、没有崩溃上报、没有后台数据收集

> 一句话：**你的笔记永远属于你**，不管 Flowix 以后还在不在。

---

### ✏️ 编辑体验

- **所见即所得的 Markdown** — 标准语法，兼容所有第三方工具
- **Tiptap 内核** — 流畅的块级编辑、表格、任务列表、代码高亮
- **Mermaid 图表** — 直接画流程图、时序图、甘特图
- **文件附件** — 图片、PDF、Office 文档都能嵌进笔记
- **多笔记本** — 按项目 / 主题分开，互不干扰
- **标签 + 收藏** — 横向分类（tag）+ 纵向重要级（收藏）两套维度
- **全局搜索** — 跨笔记本全文搜索，毫秒级响应
- **键盘党友好** — 完整快捷键 + `Cmd+K` 命令面板

---

### 🤖 AI 能力

Flowix 内置 AI 代理，**不锁死单一服务商**，也不把 AI 对话做成一次性的聊天记录。

- 🧠 **多 Provider** — OpenAI / Anthropic / DeepSeek，按需切换
- ⚡ **流式响应** — AI 边想边写，你不用干等
- 🛠️ **工具调用** — AI 不只是聊天，它能围绕文档读写笔记、搜索文件、调用工具
- 👀 **可观测** — 每次对话过程都看得到，方便你判断 AI 在干嘛
- 🛡️ **数据可控** — 只有你主动发消息时内容才离开本机，AI 不在后台偷数据
- 💾 **文档化沉淀** — 有价值的 AI 输出可以继续整理进笔记，关掉窗口也不丢

![AI Agent](./docs/images/readme-agent.png)

**典型 AI 场景**：

- 把一段口语化文字润色成书面语
- 给一篇长笔记生成摘要 / 提取待办
- 解释代码、写测试、生成正则
- 翻译、改写、扩写、缩写
- 帮你读完一篇 PDF 然后回答问题

---

### 🖥️ 桌面原生

- **Tauri 2 + Rust** — 安装包小、启动快、内存占用低
- **跨平台** — macOS（Intel / Apple Silicon）/ Windows 10+
- **多窗口** — 一条笔记可以单独开窗，方便对照阅读
- **文件关联** — 双击系统里的 `.md` 文件自动用 Flowix 打开

---

### 🚀 快速开始

```bash
# 克隆
git clone https://github.com/text2future/flowix.git
cd flowix

# 安装依赖
npm install

# 开发模式（启动完整应用）
npm run tauri dev

# 仅前端开发（localhost:1420）
npm run dev

# 生产构建
npm run tauri build

# 签名发布构建（CI / release 使用）
npm run tauri:build:production
```

**环境要求**：Node.js 20+、Rust 1.75+、macOS 14+ 或 Windows 10+。
