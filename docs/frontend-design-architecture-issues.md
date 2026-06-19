# Frontend Design Architecture Issues

Date: 2026-06-18

Scope: `app/flowix-web`, `vite.config.ts`, `package.json`

This review focuses on the frontend design architecture of the Flowix desktop app. The project is a Vite + React 19 + Tauri 2 frontend, using Zustand for state, Tailwind/shadcn-style UI primitives, Tiptap for editing, and Mermaid/Shiki for rich code and diagram rendering.

Verification performed:

- `npm.cmd run build` passed.
- Vite reported multiple chunks larger than 500 kB after minification.
- PowerShell `npm` was blocked by execution policy, so `npm.cmd` was used.

## P0 / High Priority

### 1. Initial and editor-related bundles are too large

Evidence:

- Build output contains several oversized chunks:
  - `index-Cxum1UXG.js`: about 1.6 MB minified, 533 kB gzip
  - `main-layout-*.js`: about 517 kB minified, 208 kB gzip
  - `mermaid.core-*.js`: about 610 kB minified, 146 kB gzip
  - `markdown-editor-*.js`: about 476 kB minified, 146 kB gzip
- Vite warning: "Some chunks are larger than 500 kB after minification."
- Relevant files:
  - `app/flowix-web/components/editor/extensions/shiki/shiki-highlighter.ts`
  - `app/flowix-web/components/editor/extensions/codeblock-shiki/codeblock-shiki-view.ts`
  - `app/flowix-web/components/editor/extensions/codeblock-shiki/mermaid-renderer.ts`
  - `vite.config.ts`

Risk:

- Desktop cold start and first editor open can become visibly slow.
- Heavy optional capabilities such as Mermaid, Shiki, syntax languages, themes, and advanced editor extensions can leak into paths that do not need them.
- Bundle growth is currently visible only as a build warning, not as an enforced budget.

Recommended direction:

- Add explicit `manualChunks` in `vite.config.ts` for editor, agent panel, Mermaid, Shiki, and vendor UI.
- Lazy-load Mermaid only when a Mermaid preview is opened.
- Keep Shiki language loading demand-driven; avoid broad preload based on all possible bundled languages.
- Add bundle-size tracking or a CI budget for key chunks.

### 2. `App.tsx` owns too many global side effects

Evidence:

- `App.tsx` handles view routing, theme provider, shortcut provider, config sync, memo events, agent events, open-target listener, notebook cache prewarm, and loading screen cleanup.
- Relevant areas:
  - `app/flowix-web/App.tsx`: `useMemoEvents()`
  - `app/flowix-web/App.tsx`: `useAgentEvents()`
  - `app/flowix-web/App.tsx`: `listenToUserConfigChanges`
  - `app/flowix-web/App.tsx`: `listenToAgentAccessChanges`
  - `app/flowix-web/App.tsx`: `mountOpenTargetListener`
  - `app/flowix-web/App.tsx`: hash-based preferences routing

Risk:

- Main window and preferences window share startup behavior that may not be needed in both contexts.
- Global listener lifecycle is hard to reason about as more windows/features are added.
- New boot tasks will likely keep accumulating in the root component.

Recommended direction:

- Split root concerns into:
  - `AppProviders`
  - `AppRouter`
  - `AppEventBridge`
  - `AppBootTasks`
- Make event bridges window-aware, so preferences and main window mount only the listeners they require.

### 3. `MainLayout` mixes layout, data orchestration, commands, and window behavior

Evidence:

- `app/flowix-web/windows/main/main-layout.tsx` subscribes to multiple stores, handles resizable panels, platform titlebar branching, notebook actions, document commands, history navigation, agent panel behavior, and custom events.
- Examples:
  - `useMemoStore`, `useDocumentStore`, `useDocumentHistoryStore`, `useSettingsStore`
  - `handleSelectNotebook`
  - `handleConfirmDeleteNotebook`
  - custom events such as `flowix:open-edit-notebook` and `flowix:request-delete-memo`

Risk:

- Layout changes can accidentally affect business flows.
- Business command changes can trigger unnecessary layout re-renders.
- Testing the main shell requires too much application state.

Recommended direction:

- Extract:
  - `useResizablePanels`
  - `useNotebookActions`
  - `useDocumentTitlebarActions`
  - `usePlatformTitlebar`
  - `MainShellLayout`
- Keep `MainLayout` as a composition layer instead of a command hub.

## P1 / Medium Priority

### 4. Cross-component communication relies heavily on untyped `window` events

Evidence:

- `MainLayout` dispatches events such as:
  - `flowix:open-edit-notebook`
  - `flowix:request-delete-memo`
- `MemoList` listens for several global events:
  - `flowix:open-create-notebook`
  - `flowix:open-edit-notebook`
  - `flowix:request-delete-memo`
  - `flowix:open-palette`
  - `flowix:create-memo`
- Relevant files:
  - `app/flowix-web/windows/main/main-layout.tsx`
  - `app/flowix-web/windows/main/memo-pane/memo-list.tsx`

Risk:

- Event names are stringly typed and easy to break during refactors.
- Ownership is unclear: callers do not know which component will handle the event.
- Multiple windows and repeated mounts increase the risk of duplicate or stale handlers.

Recommended direction:

- Centralize event names and payload types in a typed module.
- Prefer explicit Zustand actions or a typed internal event bus for feature-level commands.
- Reserve DOM events for true DOM integration boundaries.

### 5. Tauri RPC boundary is weakly typed

Evidence:

- `app/flowix-web/lib/tauri/client.ts` contains many `invoke<any>` and `invoke<any[]>` calls.
- The RPC function is exposed globally through `window.__tauriRpc`.
- Examples:
  - `memos.getMemos`
  - `memos.readMemo`
  - `notebooks.getAll`
  - `files.getTree`
  - `dialogs.selectFiles`

Risk:

- Backend command contract changes can silently pass TypeScript and fail at runtime.
- `any` spreads into stores and UI components.
- Global RPC exposure increases accidental coupling and makes debugging-only behavior part of the runtime surface.

Recommended direction:

- Define a typed command map: command name -> params -> response.
- Replace `any` with domain types or runtime validation for high-risk commands.
- Gate `window.__tauriRpc` behind a development-only flag or remove it.

### 6. Editor agent card extension is too large and has too many responsibilities

Evidence:

- `app/flowix-web/components/editor/extensions/agent-thread-card.tsx` is about 60 KB.
- It combines:
  - Tiptap node definition
  - Markdown tokenizing and rendering
  - HTML sanitization
  - DOM construction
  - icon definitions
  - chat store access
  - agent session creation and streaming commands
- It directly uses `marked`, `template.innerHTML`, many `document.createElement` calls, and `useChatStore.getState()`.

Risk:

- Security-sensitive rendering and business logic are coupled in one file.
- Small UI changes can affect serialization, markdown parsing, or agent behavior.
- Hard to test in isolation.

Recommended direction:

- Split into:
  - `agent-thread-card.schema.ts`
  - `agent-thread-card.markdown.ts`
  - `agent-thread-card.sanitize.ts`
  - `agent-thread-card.node-view.ts`
  - `agent-thread-card.session.ts`
- Add focused tests for markdown serialization and sanitization.

## P2 / Lower Priority

### 7. Frontend quality gates are incomplete

Evidence:

- `package.json` contains `dev`, `build`, `preview`, `tauri`, and build scripts.
- There are no frontend `lint`, `test`, or standalone `typecheck` scripts.
- No frontend test config was found outside dependencies/build output.

Risk:

- Build is the only frontend safety net.
- Store behavior, event wiring, autosave, and editor edge cases are hard to protect from regression.

Recommended direction:

- Add:
  - `typecheck`: `tsc --noEmit`
  - `lint`: ESLint for `app/flowix-web`
  - unit tests for stores/hooks
  - integration tests for document open/save/switch flows

### 8. Repository workspace includes generated and dependency directories

Evidence:

- The workspace contains:
  - `node_modules`
  - `dist`
  - `app/target`

Risk:

- Search and analysis are noisy and slower.
- Generated files can accidentally be included in packaging, backups, or manual review.

Recommended direction:

- Ensure `.gitignore` and release scripts exclude generated directories.
- Keep architecture reviews and code searches scoped to source directories.

## Suggested Fix Order

1. Add bundle analysis and split Mermaid/Shiki/editor chunks.
2. Extract root boot/event responsibilities from `App.tsx`.
3. Split `MainLayout` into shell layout plus feature hooks.
4. Replace stringly typed window events with typed actions or a typed event bus.
5. Strengthen the Tauri RPC contract.
6. Split and test the agent thread card extension.
7. Add frontend lint/typecheck/test scripts.
8. Clean generated-directory handling in workspace and release flow.
