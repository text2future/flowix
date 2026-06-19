# Codex Agent Architecture

This document records the current Codex integration shape after the CLI-backed
agent flow was implemented.

## Goals

- The agent runtime switch is global: Flowix and Codex are two runtime modes of
  the same chat panel, not two input-box-local options.
- Flowix history comes from the Flowix SQLite thread store.
- Codex history comes from the local Codex store under `~/.codex`.
- The UI renders both sources through the same `ThreadInfo` and `ChatMessage`
  shape.
- Flowix owns ReAct execution. Codex is a pipe to the Codex CLI and does not
  duplicate Codex-owned history or reasoning state.

## Backend Boundaries

`codex_cli.rs` is the runtime adapter.

- Starts `codex exec --json`.
- Resumes existing sessions with `codex exec resume --json <session_id> -`.
- Converts live JSONL events into `AgentChunk`.
- Tracks and stops in-flight Codex child processes.
- Stores a Flowix thread to Codex session mapping only when a Flowix-created
  thread starts a new Codex session.

`codex_history.rs` is the history adapter.

- Lists sessions from `~/.codex/history.jsonl` and `~/.codex/sessions/**/*.jsonl`.
- Resolves a Codex session id to its JSONL file.
- Converts persisted Codex JSONL into Flowix `ChatMessage` rows.
- Merges persisted tool call/output pairs into the same completed tool message
  shape used by live streaming.

`commands/thread.rs` exposes both stores without merging them:

- `thread_list` / `thread_get`: Flowix SQLite.
- `codex_thread_list` / `codex_thread_get`: local Codex files.

## Frontend Boundaries

`agentRuntime` is the global runtime switch.

- `flowix`: reads `threadList`, `activeThreadId`, `currentThreadTitle`.
- `codex`: reads `codexThreadList`, `activeCodexThreadId`,
  `currentCodexThreadTitle`.

The panel keeps one shared `threadStates` cache because both runtimes render the
same `ChatMessage` structure and consume the same live `AgentChunk` stream.

The history dropdown chooses its source from `agentRuntime`:

- Flowix mode loads SQLite threads and allows delete.
- Codex mode reloads `~/.codex` history and does not delete local Codex session
  files.

## Extension Pattern

To add Claude or another CLI-backed agent, avoid branching throughout the UI.
Add another runtime adapter pair:

1. Runtime runner: start/resume/stop the CLI and convert live events to
   `AgentChunk`.
2. History adapter: list local sessions and convert persisted records to
   `ChatMessage`.
3. Tauri commands: expose `<runtime>_thread_list` and `<runtime>_thread_get`.
4. Frontend runtime state: add runtime-specific active id, title, and thread
   list while keeping `threadStates` shared.

The important rule is ownership: a runtime's native session store remains the
source of truth for that runtime's history. Flowix should only keep routing
metadata when it needs to connect a Flowix-created UI thread to an external
session id.
