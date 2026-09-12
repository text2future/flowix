---
key: g1evqzl1
---

# Frontend module boundaries

This document records the target dependency rules for incremental frontend
modularization. It is a maintenance contract, not a requirement to reorganize
every feature into the same directory shape.

## Module roles

| Role | Modules | Ownership |
| --- | --- | --- |
| Foundation | `lib`, `shared`, `platform` | Framework-independent utilities, UI primitives, and Tauri adapters |
| Business capability | `memo`, `document`, `agent`, `preferences`, `plugin` | Feature state and feature operations |
| Coordination | `app`, `workspace`, `surface` | Startup, navigation transactions, placement, and cross-feature composition |
| Chrome | `shell` | Window layout, panel mechanics, titlebar/status-bar frames, and transient overlays |

Dependencies point from coordination to public feature APIs, and from features
to foundation modules. Foundation modules never depend on features.

## State ownership

| State | Owner | Invariant |
| --- | --- | --- |
| Main target, host/column placement, navigation transaction | `workspace` | `workspace.navigation.target` determines what the main work area displays |
| Loaded document session, content buffer, dirty/save lifecycle | `document` | Document state describes loading and persistence, not screen placement |
| Notebook and memo collections, list selection/filter metadata | `memo` | Memo selection is list state and does not independently select the work surface |
| Conversation, message projection, and run lifecycle | `agent` | Agent session store remains the single state owner |
| User preferences | `preferences` | Other modules consume stable settings selectors or commands |
| Panel sizes, visibility, and temporary chrome state | `shell` | Shell state contains no document, memo, or agent business state |
| Startup and cross-feature subscriptions | `app` | Application effects coordinate owners without becoming another source of truth |

During migration, duplicated fields may remain for compatibility. New writes
must follow the owning module's transaction, and compatibility mirrors must not
become additional authorities.

## Public API rules

Cross-feature production imports use an owning feature public entrypoint, for
example `@features/document/public/workspace-api`. Imports such as
`@features/document/store/...` are private implementation dependencies. A
consumer-specific public entrypoint is preferred over a broad barrel when it
avoids loading unrelated UI modules or creating an import cycle.

Public APIs expose business intent and stable snapshots. They do not expose a
whole mutable store or arbitrary `setState` access. A temporary migration API
may return a narrow `Pick` of a store; its fields form an explicit compatibility
contract and should shrink as higher-level commands are introduced.

Same-feature code may use its own internal paths. Tests may import internals
when they are explicitly testing an internal unit.

## Navigation transaction

Workspace owns the order of a navigation change:

1. Begin a navigation request and retain the previous target.
2. Ask document to flush the outgoing editable session.
3. Ask the owning feature to load or select the requested entity.
4. Commit the workspace target only if the request is still current.
5. On failure, restore the previous owner snapshots and mark navigation failed.

Document owns session transitions and persistence. Memo owns notebook/list
selection. Plugin owns artifact interpretation. Workspace calls their public
APIs and must not read their private stores directly.

## Incremental enforcement

Boundary enforcement is ratcheted per migrated dependency seam. A file is added
to the strict check only after existing private imports are removed. From that
point it cannot add cross-feature deep imports again. Remaining legacy seams are
migrated independently so architecture work stays reviewable and behavior can
be verified with existing feature tests.

The first protected module is `features/workspace`: all of its production
dependencies on other features use consumer-facing APIs below each feature's
`public/` directory.

## Composition progress

`app/main-window` owns notebook management and plugin-opening coordination.
`features/shell/main-layout` receives those operations through
`MainLayoutBusinessController`, leaving their persistence, rollback, error
handling, and cross-feature writes outside the layout component. Shell still
contains other presentation-specific integrations; they should be extracted
in independent batches after their behavior boundaries are identified.

The `app/main-window` composition code also consumes Workspace through
`features/workspace/public/main-window-api`. This keeps the composition root
aware of feature capabilities without binding it to Workspace's Zustand state
shape or use-case file layout.

Application update lifecycle, DSH download observation, and DSH onboarding
persistence are owned by `app/main-window/use-main-window-system-controller`.
Shell receives their current presentation state through
`MainLayoutSystemController`; it no longer starts those subscriptions or writes
the onboarding flag itself.

The DSH onboarding and installation prompt is owned by Preferences and exposed
through `features/preferences/public/dsh-install-prompt`. Shell only places the
prompt in its overlay stack and supplies controller state from `app/main-window`.

`features/shell/main-layout` now consumes Document, Memo, Agent, Surface, and
Workspace through their `public/shell-api` entrypoints. These entrypoints are
an explicit consumer contract. Document, Memo, and Workspace expose dedicated
Shell view-model hooks, so MainLayout no longer imports or calls their Zustand
stores. The public hooks retain narrow selectors and shallow equality inside
the owning module, preserving render-subscription behavior while hiding store
shape and implementation paths from Shell.

MainLayout delegates bottom-bar composition to `MainStatusBarHost` and overlay
composition to `MainPromptHost`. These hosts group cohesive presentation props
and keep platform navigation and prompt ordering outside the central layout
tree. Their cross-feature imports are protected by the public-entrypoint rule.

Middle-column switching is coordinated by
`useMainMiddleColumnController`. It owns the Agent conversation list's lazy
prefetch, mount retention, readiness transition, and the collapsed Memo list's
hover-preview lifecycle. MainLayout now consumes presentation state and event
handlers instead of managing those two surface lifecycles directly. Its
cross-feature dependencies are protected by the same public-entrypoint rule.

Shell panel geometry and visibility transitions are coordinated by
`useMainPanelController`. It owns the single viewport-width snapshot, left
navigation resizing, Memo-list resizing, browser-column split geometry,
collapse coupling, and trackpad swipe transitions. `useResizablePanels`
receives that viewport snapshot instead of registering a second resize
listener. Layout rendering consumes the controller's widths and commands and
does not implement panel constraints itself. The pure swipe transition table
has a focused unit-test contract so future panel additions cannot silently
change the existing two-panel gesture semantics.

Browser-column chrome consumes Workspace through
`features/workspace/public/browser-column-api`. The API supplies a derived,
read-only tab view model plus intent-level selection, close, reorder, focus,
flush-registration, and move-to-main-column operations. Shell no longer reads
Workspace stores or invokes its coordination use cases directly. Browser
surface hosting, fullscreen document chrome, and Agent icon rendering are also
consumed through their owning modules' Shell public entrypoints. Boundary
checks protect both BrowserColumn production components from deep imports.

Global search now consumes dedicated Memo and Agent view models. Shell no
longer reads either feature's Zustand stores, mutates Agent session metadata,
or calls Memo session internals directly. The entire component is protected by
the cross-feature public-entrypoint rule.

Agent session runtime bridge installation and chunk-completion reconciliation
live in `agent-session-runtime-bridges`. The session store remains the single
composition root while staying below its enforced size ceiling.

The application root consumes Preferences and Agent runtime state through
`public/app-api` view models. This keeps the root aware of startup capabilities
without coupling it to the underlying Zustand store shape.

Main-window event synchronization now calls intent-level Memo, Document, and
Workspace application APIs. App no longer receives those modules' Store
objects. Memo owns derived-metadata refresh and local tag rename/delete
projection updates; Document owns the active-conversation subscription; and
Workspace owns persistence of the corresponding restore selection. Boundary
checks prohibit `public/app-api` files from re-exporting complete Stores.

Preferences exposes runtime selectors and commands through
`public/runtime-api`: language snapshots and subscriptions, editor typography,
property fields, Agent visibility, and theme preference commands. Agent,
Document, Editor, Shortcuts, and Theme are protected from importing the
Preferences Store or private settings hooks directly.

Memo navigation and list-view preferences use the same runtime contract, and
Memo is covered by the Preferences boundary rule. The main-window system
controller also uses the application Preferences API instead of the broad
feature barrel, keeping private Store exports out of the composition root and
preventing the full Preferences view from entering the startup graph.

Some feature titlebars still consume Shell chrome because their DOM ownership
is currently inside the feature renderer. This is an explicit composition
exception, not a foundation-layer API: moving those components to `shared`
would create a lower-layer dependency on Workspace and platform behavior. A
future removal must invert rendering through Shell-owned slots; it must not be
implemented as a path-only file move.

The remaining Shell-to-Workspace navigation seams use intent-specific public
contracts. Work-column chrome receives a derived transfer capability rather
than reading the work-column store. Markdown drag-and-drop calls the public
browser-column navigation command, while the global search palette uses a
search-specific navigation entrypoint for notebook and Agent-conversation
selection. The first two files are fully protected from cross-feature deep
imports; global search is ratcheted on its migrated Workspace seam while its
legacy Memo and Agent dependencies are handled separately.

Navigation failure and application update prompts are isolated presentation
components under `features/shell/components/prompts`. The navigation prompt
uses Workspace's public API, and boundary checks protect prompt components from
reaching into another feature's private implementation.
