<p align="right">
  <a href="./README.md"><b>English</b></a> | <a href="./README.zh-CN.md">简体中文</a>
</p>

<!-- Codex write-access test: 2026-09-10 -->

<p align="center">
  <img src="./docs/images/app-icon.png" width="120" alt="Flowix" />
</p>

<h1 align="center">Notes for you,<br />Memory for your agents.</h1>

<p align="center"><strong>The Markdown notebook where your words seamlessly become durable context for AI agents.</strong></p>

<p align="center">
  Markdown · Open Source · Multi Agent · MCP &amp; CLI
</p>

<p align="center">
  <a href="https://flowix-memo.com/"><b>Download</b></a> ·
  <a href="https://flowix-memo.com/"><b>Website</b></a> ·
  <a href="https://flowix-memo.com/docs/"><b>Docs</b></a>
</p>

---

<img src="./docs/images/readme-introduce.gif" width="100%" alt="Flowix" />

## Flowix turns notes into working memory

Write in Markdown, point an agent to the context it needs, and save the result back to the same note — ready to review, edit, and reuse next time.

<img src="./docs/images/home-write.png" width="100%" alt="Flowix notes shown across light and dark themes" />

---

## Keep work moving

Keep product work, development, research, and personal knowledge together, so agents can continue without starting over.

| Use case | What it does |
| --- | --- |
| **Product work** | Keep requirements, feedback, decisions, and PRDs up to date. |
| **Software development** | Give coding agents the context to continue your project. |
| **Research** | Keep sources, analysis, and conclusions together and reusable. |
| **Personal knowledge** | Turn notes, plans, and preferences into useful agent context. |

<p align="center"><img src="./docs/images/home-nav.png" width="60%" alt="Flowix navigation for notes, conversations, tasks, and tags" /></p>

---

## Connect every agent to the same memory

Use agents inside Flowix or connect **Codex**, **Claude Code**, **OpenCode**, **Hermes**, and other MCP or CLI tools — all working from the same notes and context.

<p align="center"><img src="./docs/images/home-agent.png" width="60%" alt="Flowix connecting Codex, Claude Code, OpenCode, Hermes, and Flowix Agent to the same note" /></p>

---

## dsh-flowix-memory plugin

[dsh-flowix-memory](dsh-flowix-memory/README.md) is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that connects any Harness agent to your **local Flowix notes** through the bundled `flowix-cli` MCP server: the agent gets the `mcp__flowix__memo` tool to search, read, create, and edit Flowix memos (including mind maps).

Install it into the `flowix` Harness profile from the flowix-main checkout (not yet published to npm). In other DSH clients, `flowix` is an ordinary custom profile name:

```sh
dsh plugin --profile flowix add ./dsh-flowix-memory
```

Requires the `flowix` CLI on `PATH` (or set `FLOWIX_CLI_PATH`) with access to your notebook data (`~/.flowix`). See the [plugin README](dsh-flowix-memory/README.md) for details.

## Passing Markdown to the CLI

Use a UTF-8 file as the recommended way to pass Markdown content to `create` and `write`, especially from Windows PowerShell 5.1. This avoids text being damaged by stdin pipeline encoding. UTF-8 files may include a BOM, and files without a BOM are supported too.

```powershell
flowix create <notebook> --file body.md --json
flowix write <id> --file body.md --json
```

On Windows, stdin is no longer read implicitly when neither input option is given, preventing PowerShell 5.1's `$OutputEncoding` from corrupting non-ASCII text. If the caller has guaranteed UTF-8 stdin, opt in explicitly:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 body.md | flowix create <notebook> --stdin --json
```

`--file` and `--stdin` are mutually exclusive. The `--file` path is read directly as UTF-8; a missing, unreadable, or invalid UTF-8 file returns an error. With `--json`, errors use the stable `{ok:false,error:{code,message}}` shape.

---

## Your notes stay local and under your control

Flowix keeps your work as plain Markdown files on your device. You choose what agents can access, when context is sent, and how your files are synced, backed up, or versioned.

- **Files you can open anywhere** — Your notes are saved as plain Markdown on your device, so you can read and edit them with other apps.
- **Agents see only what you choose** — Share a single note, a folder, or a whole notebook — only when you want an agent to use it.
- **Use the agents you already trust** — Connect Codex, Claude Code, OpenCode, or another external agent. Flowix shares only the context you choose, when you start a task.
- **Sync and back up your way** — Use the sync, backup, or version-control tools you already trust. There's nothing to export.

---

## Product preview

| | |
| --- | --- |
| <img src="./docs/images/gh-detail-1.png" width="100%" alt="Note library with tags" /><br/>*Note library with tags* | <img src="./docs/images/gh-detail-2.png" width="100%" alt="Note detail with agent presets" /><br/>*Note detail with agent presets* |
| <img src="./docs/images/gh-detail-3.png" width="100%" alt="Agent model picker" /><br/>*Agent model picker* | <img src="./docs/images/gh-detail-4.png" width="100%" alt="Full-text and file search" /><br/>*Full-text and file search* |
| <img src="./docs/images/gh-detail-5.png" width="100%" alt="Provider and MCP configuration" /><br/>*Provider and MCP configuration* | <img src="./docs/images/gh-detail-6.png" width="100%" alt="Code file browsing and editing" /><br/>*Code file browsing and editing* |

---

## Quick start

1. Download and install Flowix from [the website](https://flowix-memo.com/).
2. Create a new local folder, or register an existing folder as a notebook.
3. Create a document and write down the task background, reference materials, goals and constraints.
4. Call an agent from within the document, or keep organizing content with tags and properties.

## Local development

```bash
git clone https://github.com/text2future/flowix.git
cd flowix
npm install

npm run tauri dev
npm run dev
npm run tauri build
```

The development environment requires Node.js 20+, Rust 1.75+ and Tauri v2; the desktop app supports macOS 14+ and Windows 10+.

## License

Flowix is open source under the MIT License.
