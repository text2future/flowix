import { retainSessionViewStates } from '../model/session-view-retention';
import { SESSION_HISTORY_LIMIT, SESSION_HEADER_STATE_LIMIT, SESSION_VIEW_STATE_LIMIT } from '../model/session-limits';
import { restoreViewRecovery } from '../model/session-view-state';
import type { WorkspaceSession } from '../model/workspace-session';
import { emptySessionTransaction, type SessionNavigationEntry, type SessionCurrentEntry } from '../model/session-navigation';
import { restoreWorkspaceWebRuntime } from '../model/web-navigation';
import type { WorkspaceSurfaceOpenTarget } from '../model/surface-target';
import { clampSplitRatio } from '../model/browser-column-layout';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function parseSessionTarget(value: unknown): WorkspaceSurfaceOpenTarget | null {
  if (!record(value)) return null;
  const text = (key: string) => typeof value[key] === 'string' && Boolean(value[key]);
  switch (value.kind) {
    case 'empty': return { kind: 'empty' };
    case 'web': if (!text('url')) return null; break;
    case 'external': if (!text('path')) return null; break;
    case 'agent-conversation': if (!text('instanceId')) return null; break;
    case 'file-browser':
      if (!(text('folderPath') || text('activeFilePath')) || typeof value.fileTreeVisible !== 'boolean'
        || typeof value.fileTreeWidth !== 'number') return null;
      break;
    case 'folder-collection': if (!text('notebookId') || !text('folderPath')) return null; break;
    case 'media': if (!text('filePath') || (value.resourceKind !== 'image' && value.resourceKind !== 'video')) return null; break;
    case 'table': case 'media-library': if (!text('filePath')) return null; break;
    case 'collection':
      if (!text('notebookId') || !text('collectionId') || !text('displayId') || !text('filePath')
        || !text('notebookPath') || !['table', 'media_library', 'work_documents'].includes(String(value.collectionType))) return null;
      break;
    case 'collection-reference': if (!text('notebookId') || !text('collectionId')) return null; break;
    case 'plugin-workbench':
      if (!record(value.plugin) || !record(value.plugin.manifest)
        || typeof value.plugin.manifest.id !== 'string' || typeof value.plugin.manifest.name !== 'string') return null;
      break;
    default: return null;
  }
  // Validate serialized targets at the JSON boundary. Runtime handlers are never deserialized.
  return value as unknown as WorkspaceSurfaceOpenTarget;
}

function parseEntry(value: unknown): SessionNavigationEntry | null {
  if (!record(value) || typeof value.id !== 'string' || !value.id) return null;
  const target = parseSessionTarget(value.target);
  if (!target || target.kind === 'empty') return null;
  return { id: value.id, target, title: typeof value.title === 'string' ? value.title : '',
    icon: typeof value.icon === 'string' ? value.icon : null,
    openedAt: typeof value.openedAt === 'number' ? value.openedAt : 0 };
}

export function restoreCanonicalSession(value: unknown, fallback: WorkspaceSession): WorkspaceSession {
  if (!record(value)) return fallback;
  let navigation = fallback.navigation;
  if ('navigation' in value) {
    const saved = record(value.navigation) ? value.navigation : {};
    const parsed = parseEntry(saved.current);
    const current: SessionCurrentEntry | null = parsed && parsed.target.kind !== 'collection-reference'
      ? { ...parsed, target: parsed.target.kind === 'external'
        ? { ...parsed.target, transitionId: null } : parsed.target } : null;
    const stack = (items: unknown) => Array.isArray(items)
      ? items.flatMap((entry) => { const next = parseEntry(entry); return next ? [next] : []; }).slice(-SESSION_HISTORY_LIMIT) : [];
    navigation = { current, backStack: stack(saved.backStack), forwardStack: stack(saved.forwardStack),
      transaction: { ...emptySessionTransaction(), phase: current ? 'committed' : 'idle' } };
  }
  const headerState: WorkspaceSession['headerState'] = {};
  if (record(value.headerState)) {
    for (const [key, state] of Object.entries(value.headerState).slice(-SESSION_HEADER_STATE_LIMIT)) {
      if (record(state) && typeof state.addressBarVisible === 'boolean') {
        Object.defineProperty(headerState, key, { enumerable: true, value: { addressBarVisible: state.addressBarVisible } });
      }
    }
  }
  const current = navigation.current;
  if (current && !headerState[current.id]) {
    const activeRuntime = fallback.viewStates[current.id]?.webRuntime;
    const key = Object.keys(headerState).find((id) => activeRuntime && fallback.viewStates[id]?.webRuntime === activeRuntime);
    if (key) headerState[current.id] = headerState[key];
  }
  const viewStates: WorkspaceSession['viewStates'] = {};
  if (record(value.viewStates)) {
    for (const [key, state] of Object.entries(value.viewStates).slice(-SESSION_VIEW_STATE_LIMIT)) {
      const runtime = record(state) ? restoreWorkspaceWebRuntime(state.webRuntime) : null;
      const recovery = record(state) ? restoreViewRecovery(state.recovery) : undefined;
      if (runtime || recovery) Object.defineProperty(viewStates, key, { enumerable: true, value: { ...(runtime ? { webRuntime: runtime } : {}), ...(recovery ? { recovery } : {}) } });
    }
  }
  return retainSessionViewStates({ ...fallback, navigation, headerState,
    viewStates: 'viewStates' in value ? viewStates : fallback.viewStates, notebookSwitchesInFlight: 0 });
}

export function restoreBrowserLayout(value: unknown, fallback: { visible: boolean; splitRatio: number }) {
  return record(value) ? {
    visible: typeof value.visible === 'boolean' ? value.visible : fallback.visible,
    splitRatio: typeof value.splitRatio === 'number' ? clampSplitRatio(value.splitRatio) : fallback.splitRatio,
  } : fallback;
}
