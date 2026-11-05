import { SESSION_VIEW_SLOT_LIMIT } from './session-limits';
/** Serializable renderer state. DOM, editor instances and callbacks stay in adapters. */
export type SessionViewSnapshot =
  | { kind: 'editor'; anchor: number; head: number; selectionType?: 'text' | 'node' | 'all'; scrollTop: number; scrollLeft: number }
  | { kind: 'scroll'; scrollTop: number; scrollLeft: number }
  | { kind: 'media'; currentTime: number; volume: number; muted: boolean; playbackRate: number };

export interface SessionViewRecovery {
  version: 1;
  slots: Record<string, SessionViewSnapshot>;
}

export function restoreViewSnapshot(value: unknown): SessionViewSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const number = (key: string) => typeof v[key] === 'number' && Number.isFinite(v[key]) && (v[key] as number) >= 0;
  if ((v.kind === 'editor' || v.kind === 'scroll') && number('scrollTop') && number('scrollLeft')) {
    const scroll = { scrollTop: v.scrollTop as number, scrollLeft: v.scrollLeft as number };
    if (v.kind === 'scroll') return { kind: 'scroll', ...scroll };
    if (number('anchor') && number('head') && Number.isInteger(v.anchor) && Number.isInteger(v.head)) {
      return { kind: 'editor', anchor: v.anchor as number, head: v.head as number, ...scroll,
        ...(v.selectionType === 'text' || v.selectionType === 'node' || v.selectionType === 'all' ? { selectionType: v.selectionType } : {}) };
    }
  }
  if (v.kind === 'media' && number('currentTime') && number('volume') && (v.volume as number) <= 1
    && number('playbackRate') && (v.playbackRate as number) > 0 && (v.playbackRate as number) <= 16 && typeof v.muted === 'boolean') {
    return { kind: 'media', currentTime: v.currentTime as number, volume: v.volume as number,
      playbackRate: v.playbackRate as number, muted: v.muted };
  }
  return null;
}

export function restoreViewRecovery(value: unknown): SessionViewRecovery | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !v.slots || typeof v.slots !== 'object' || Array.isArray(v.slots)) return undefined;
  const slots = Object.fromEntries(Object.entries(v.slots).slice(-SESSION_VIEW_SLOT_LIMIT).flatMap(([key, raw]) => {
    const snapshot = restoreViewSnapshot(raw);
    return snapshot && key.length <= 1024 ? [[key, snapshot]] : [];
  }));
  // Older Markdown adapters keyed slots by file path or ephemeral display ID.
  // Entries already isolate documents; the last legacy slot is the latest
  // capture (writes append slots). An existing semantic slot takes precedence.
  const legacyMarkdown = Object.entries(slots).filter(([key, snapshot]) => key.startsWith('markdown:') && snapshot.kind === 'editor');
  if (slots.markdown?.kind !== 'editor' && legacyMarkdown.length) {
    slots.markdown = legacyMarkdown[legacyMarkdown.length - 1][1];
  }
  for (const [key] of legacyMarkdown) delete slots[key];
  return { version: 1, slots };
}
