---
key: bnj8t85d
kind: guide
status: overview
agentRole: onboarding
keywords:
  - overview
  - what-is
  - value-prop
  - quickstart
  - setup
  - ai-agent
---
# Welcome

&nbsp;

Flowix Memo is **++a documentation workspace for AI agents++**. It helps solve common problems that come up when working with AI agents:

- [ ] Prompts are scattered across different places and hard to manage
- [ ] AI agents keep making the same mistakes because context gets lost
- [ ] Workflows proven through chat are difficult to capture and reuse

Flowix Memo gives agents a place to manage documents and context. It helps capture workflows, recurring issues, personal preferences, and other reusable knowledge.

Your own notes can also become high-quality input for future AI work.

---

## Use Cases

### 1. Keep notes and manage AI requests, memory, and outputs

Use Flowix Memo for everyday notes: reading notes, travel plans, work logs, personal writing, and more.

You can also write requirements, source material, and reference links into a document, then ask an agent to summarize, rewrite, answer questions, break down tasks, or write code based on that context.

Agent outputs can be written back into your documents, creating a memory you can review, edit, and reuse. This turns AI collaboration from one-off chats into workflows that accumulate over time.

### 2. Local-first notes that last

Flowix Memo stores notes as local Markdown files. You can see the `.md` files directly in your system folders and manage them with your own sync, backup, or version control tools.

Your content is not locked into a proprietary cloud service. Even if you switch tools later, your notes remain plain Markdown files that other editors can read.

### 3. Organize context by project

Flowix Memo organizes content with notebooks. A notebook is just a local folder, so you can keep work, research, client projects, journals, knowledge bases, or code projects in separate notebooks.

When you switch notebooks, Flowix switches the active context. That keeps unrelated projects out of the way and makes it easier to give AI agents only the material they need.

### 4. Record and reuse AI behavior

Flowix Memo can run its built-in AI agent inside documents, and it can also connect to local CLI agents such as Claude Code, Codex, and Hermes.

You control what an agent can see: the current note, a folder, the full notebook, or a project directory. Clearer context leads to more stable outputs, and recorded work is easier to review, revise, and continue.

### 5. Connect more agent workflows with Flowix CLI and MCP

Flowix CLI is useful for non-interactive note operations by local agents (==some agent sandboxes may block it==).

MCP lets Flowix Memo act as a standard tool for other AI clients that support MCP. External AI agent clients can read, search, and update your documents through tool calls, turning your notes into long-term context. Compared with the CLI, MCP is the recommended way to connect external AI agent clients. To minimize context usage, Flowix Memo's MCP integration is designed around a single tool.

---

## Quick Start

### 1. Create or register a notebook

A notebook is a local folder. Create an empty folder or register an existing one, and Flowix Memo will manage the Markdown files inside it.

### 2. Write context your agent can use

A Flowix document can be both a note and an agent task brief. Include:

- Background: what needs to be handled.
- Sources: what the agent should reference.
- Goal: what result you want.
- Constraints: format, boundaries, and things to watch for.

The clearer the brief, the easier it is for the agent to pick up the task.

### 3. Organize notes with tags

Write tags directly in the body, such as `#idea`, `#meeting`, `#todo`, `#prompt`, or `#agent`. Flowix Memo detects them automatically and shows them in the sidebar filter.

### 4. Add structured details with properties

When tags are not enough, use properties for more stable metadata, such as `status`, `kind`, `source`, `agentRole`, and `keywords`.

---

## Learn More

Flowix Memo is an open-source project independently built by a China-based developer. The code is public, transparent, and available for learning and use. The community welcomes Vibe Coding and pull request contributions.

- Website: [https://flowix-memo.com/](https://flowix-memo.com/)
- Documentation: [https://flowix-memo.com/docs/](https://flowix-memo.com/docs/)
- GitHub: [https://github.com/text2future/flowix](https://github.com/text2future/flowix)

---

#flowix #gettingstarted #agent #setup

&nbsp;
