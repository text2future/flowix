<a href="../README.md">简体中文</a> · <a href="./README.en.md">English</a> · <a href="https://flowix-memo.com/roadmap">Roadmap</a> · <a href="https://flowix-memo.com/updates">What's New</a>

# Flowix Memo

[![Platform](https://img.shields.io/badge/Platform-macOS%20|%20Windows-0078D4)](https://github.com/text2future/flowix/releases)
[![Latest Release](https://img.shields.io/github/v/release/text2future/flowix)](https://github.com/text2future/flowix/releases)

![Flowix Memo](./images/readme-banner.png)

**Flowix Memo is a local documentation workspace built for AI agents.**

It brings everyday notes, task requirements, reference material, agent conversations, and outputs into a single Markdown workflow, so context can accumulate over time, remain editable, and be reused whenever you need it.

Flowix Memo is designed to solve a few common problems:

- Prompts and task briefs are scattered across different places and hard to manage
- Agents lose important context and repeat the same mistakes
- Workflows and valuable outputs developed through conversations are difficult to capture and reuse

In Flowix Memo, a document can be a note, an agent task brief, durable memory, and a work product. AI collaboration no longer ends with a one-off chat—it becomes knowledge you can review, edit, and use again.

## What You Can Do

### Keep everyday notes and preserve agent work

Write reading notes, travel plans, work logs, and personal journals. You can also put requirements, source material, and reference links into a document, then ask an agent to summarize, rewrite, answer questions, break down tasks, or write code from that context.

Agent outputs can be written back into the document and become input for the next task.

### Organize project context with notebooks

A notebook is simply a local folder. Keep work, research, client projects, journals, knowledge bases, or code projects in separate notebooks.

Switching notebooks also switches your default working context. This reduces interference between unrelated projects and makes it easier to give an agent only the material it needs.

### Keep your content local for the long term

Notes are stored as plain Markdown files on your disk. You can open them with other editors and manage them with your preferred sync, backup, or version control tools.

Your content is not locked into a proprietary cloud service. Even if you change tools later, your documents remain readable, portable, and usable.

### Use different agents inside documents

Flowix Memo includes a built-in AI agent and can also connect to local CLI agents such as Claude Code, Codex, and Hermes. For each task, you control what an agent can access: the current note, a folder, the full notebook, or a project directory.

Clearer context leads to more reliable output. Because the process is recorded, it is also easier to review, revise, and continue the work.

The built-in agent uses a BYOK (Bring Your Own Key) model. Selected context is sent to your configured model provider only when you actively make a model request.

### Connect external agent workflows

Flowix CLI lets local agents perform non-interactive note operations. MCP enables external agent clients with MCP support to read, search, and update Flowix documents.

MCP is the recommended option for external agent clients. See the [documentation](https://flowix-memo.com/docs/) for setup instructions and tool details.

## Core Capabilities

**Markdown and local folders**: Access, back up, move, or version your data directly<br>
**Tags and properties**: Organize structured information with inline tags and YAML Frontmatter<br>
**BYOK and multiple providers**: Use model services including OpenAI, Anthropic, and DeepSeek<br>
**Built-in and local agents**: Work with the built-in agent, Claude Code, Codex, or Hermes inside documents<br>
**CLI and MCP**: Connect your documents to local and external agent workflows<br>
**Multiple windows and tabs**: Pop notes into child windows and move tabs between windows

![AI Agent](./images/readme-agent.png)

## Quick Start

1. Download and install Flowix Memo from [Releases](https://github.com/text2future/flowix/releases).
2. Create a local folder, or register an existing folder as a notebook.
3. Create a document and write down the task background, reference material, goal, and constraints.
4. Use an agent inside the document, or continue organizing your content with tags and properties.

## Local Development

```bash
git clone https://github.com/text2future/flowix.git
cd flowix
npm install

npm run tauri dev
npm run dev
npm run tauri build
```

Development requires Node.js 20+, Rust 1.75+, and Tauri v2. The desktop app supports macOS 14+ and Windows 10+.

## More Information

Issues and pull requests are welcome.

- Website: [https://flowix-memo.com/](https://flowix-memo.com/)
- Documentation: [https://flowix-memo.com/docs/](https://flowix-memo.com/docs/)
- GitHub: [https://github.com/text2future/flowix](https://github.com/text2future/flowix)
