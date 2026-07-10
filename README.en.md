<div align="center">

# Flowix

[中文](README.md) · [English](README.en.md)

**Manage ideas and AI conversations with documents.**

A local-first desktop note app that brings notes, knowledge work, and AI conversations into one document workflow.

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
git clone https://github.com/aicollaborate/flowix.git
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

---

### CLI Tool (Sidecar)

Flowix ships with a standalone `flowix` command that **shares the same
`memo_file` storage** as the desktop app. Edits from the terminal are visible
in the desktop UI within about 1 second, and vice versa, through the filesystem
watcher.

Build and expose it to `PATH`:

```bash
# 1. Compile the CLI (release, current host)
npm run cli:build

# 2. Symlink the sidecar into PATH
ln -sf "$(pwd)/app/flowix-desktop/binaries/flowix-cli-$(rustc -vV | sed -n 's|host: ||p')" /usr/local/bin/flowix

# 3. Verify
flowix --version
```

Or copy it from an existing `.app` bundle:

```bash
cp "app/flowix-desktop/target/release/bundle/macos/Flowix.app/Contents/MacOS/flowix-cli" /usr/local/bin/flowix
```

#### Commands

```bash
flowix --version
flowix --help

flowix notebooks              # List all notebooks
flowix list <notebook>        # List notes in a notebook
flowix show <id>              # Print a note to stdout
flowix create <notebook>      # Create from stdin (echo "# title" | flowix create work)
flowix write <id>             # Overwrite a note from stdin
flowix edit <id> --old <text> --new <text>
flowix search <query>         # Full-text search
```

#### Environment

- `FLOWIX_HOME`: override config dir (default `~/.flowix`)
- `FLOWIX_DATA`: override data dir (default `<OS data dir>/flowix`)

#### Data Flow

- CLI reads `~/.flowix/notebook.json` + `<notebook>/.metadata/index.json` + `<notebook>/*.md`
- Writes are atomic (write tmp + `fs::rename`), sharing the desktop app's code path
- The CLI is a **fully independent** process from the desktop app; the desktop watcher picks up `index.json` changes automatically

---

### Distribution (CI / Homebrew)

Release artifacts are built automatically by GitHub Actions (`.github/workflows/release.yml`):

- 3-platform sidecar: macOS (arm64 + x64) / Linux / Windows
- 3-platform Tauri bundle: `.dmg` / Windows NSIS `.exe` / `.deb` + `.AppImage`
- Trigger: `git tag v0.1.0 && git push --tags`

Install CLI on macOS with Homebrew:

```bash
brew install aicollaborate/flowix/flowix
# or the .app:
brew install --cask aicollaborate/flowix/flowix
```

For direct downloads, see [GitHub Releases](https://github.com/aicollaborate/flowix/releases).

---

### Contributing

PRs, issues, and discussions are welcome.
Before submitting code, read [CLAUDE.md](CLAUDE.md) for the project structure and conventions.

### License

[CC BY-NC 4.0](LICENSE) — Attribution, Non-Commercial. Contact the author for commercial licensing.
