# Flowix Memo

<a href="../README.md">中文</a> · <a href="./README.en.md">English</a> · <a href="https://flowix-memo.com/roadmap">Roadmap</a> · <a href="https://flowix-memo.com/updates">Updates</a>

**Manage ideas and AI conversations with documents.**

A local-first desktop note app that brings notes, knowledge work, and AI conversations into one document workflow.

[![Platform](https://img.shields.io/badge/Platform-macOS%20|%20Windows-0078D4)](https://github.com/text2future/flowix/releases)
[![Latest Release](https://img.shields.io/github/v/release/text2future/flowix)](https://github.com/text2future/flowix/releases)

![Flowix](./images/readme-banner.png)

</div>

---

> **What is Flowix?**
> A desktop workspace for managing ideas and AI conversations as documents.
> Plain Markdown files stay on your disk; AI joins when you need help writing,
> organizing, or reasoning.

### Introduction

Flowix is a **local-first** desktop note-taking app for ideas, references,
tasks, and AI conversations.

Everything you write lives as plain files on your own disk: open, move,
or migrate them whenever you want. The AI assistant can polish, summarize,
translate, look things up, write code, or continue a conversation around
your documents, but it **never sends your data anywhere without your
explicit action**.

We believe good tools should **respect your content, respect your focus,
and respect your data**: no ads, no algorithmic feeds, no "log in first".

---

### Who Is It For

| Role | Typical use |
|------|-------------|
| **Writers / Bloggers** | Draft, revise, save ideas, captions |
| **Students / Researchers** | Take notes, summarize papers, build zettelkasten |
| **Developers** | Snippets, code explanations, tests, lookups |
| **Product / Design** | Specs, sketches, user interviews, design notes |
| **Privacy-conscious users** | Everything stays local, with no cloud dependency |

> Short version: **if you want ideas, references, and AI conversations to become documents**, Flowix fits.

---

### Local-First

Flowix is built on the **Local-First** principle: your data lives on
your disk first, not on some vendor's server.

What that means in practice:

- **Files are the data**: notes are plain Markdown + YAML frontmatter
  in `~/Documents/flowix/<notebook>/`, openable by any editor
- **Config is the config**: `~/.flowix/` is plain JSON, readable,
  editable, and scriptable
- **No account, no cloud**: no signup, no user ID, no "log in first"
- **Open and transparent**: code under [CC BY-NC 4.0](LICENSE)
- **Portable**: zip the data folder and take it to any machine
- **No telemetry**: no analytics, no crash reports, no background sync

> One line: **your notes are yours**, whether or not Flowix still exists.

---

### Editing Experience

- **WYSIWYG Markdown**: standard syntax, compatible with everything
- **Tiptap core**: fluid block editing, tables, task lists, code highlight
- **Mermaid diagrams**: flowcharts, sequence diagrams, and gantt charts in your notes
- **Attachments**: images, PDFs, and Office files embedded inline
- **Notebooks**: split by project or topic, fully isolated
- **Tags + favorites**: organize horizontally with tags and vertically with favorites
- **Global search**: full-text search across notebooks, with millisecond response
- **Keyboard-first**: full shortcuts + `Cmd+K` command palette

---

### AI Capabilities

Flowix ships with a built-in AI agent: **not locked to one provider**, and
not trapped in disposable chat threads.

- **Multi-provider**: OpenAI / Anthropic / DeepSeek, switch anytime
- **Streaming**: AI thinks and writes in parallel, no waiting
- **Tool use**: the agent works around your documents: reading and
  writing notes, searching files, calling tools
- **Observable**: every turn's reasoning is visible, so you can judge what the agent is doing
- **You control the data**: content only leaves your machine when
  you actively send a message; no background exfiltration
- **Documented output**: useful AI responses can be folded back into
  your notes, with no loss across restarts

![AI Agent](./images/readme-agent.png)

**Typical AI workflows**:

- Polish conversational text into a formal draft
- Summarize a long note and extract todos
- Explain code, write tests, generate regexes
- Translate, rewrite, expand, condense
- Read a PDF and answer questions about it

---

### Desktop Native

- **Tauri 2 + Rust**: small installer, fast startup, low memory use
- **Cross-platform**: macOS (Intel / Apple Silicon) / Windows 10+
- **Multi-window**: pop a note out into its own window for side-by-side reading
- **File association**: double-click a `.md` file to open it in Flowix

---

### Quick Start

```bash
# Clone
git clone https://github.com/text2future/flowix.git
cd flowix

# Install dependencies
npm install

# Full app development (with Rust backend)
npm run tauri dev

# Frontend only (localhost:1420)
npm run dev

# Production build
npm run tauri build

# Signed release build (CI / release)
npm run tauri:build:production
```

**Requirements**: Node.js 20+, Rust 1.75+, macOS 14+ or Windows 10+.
