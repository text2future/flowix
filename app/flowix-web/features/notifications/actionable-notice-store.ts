export type ActionableNoticeTone = 'neutral' | 'error' | 'warning';
export type ActionableNoticeActionVariant = 'default' | 'outline' | 'destructive';

export interface ActionableNoticeAction {
  id: string;
  label: string;
  variant?: ActionableNoticeActionVariant;
  run: () => void | Promise<void>;
}

export interface ActionableNotice {
  id: string;
  priority: number;
  tone: ActionableNoticeTone;
  title: string;
  message?: string;
  actions: ActionableNoticeAction[];
  dismissible?: boolean;
  onDismiss?: () => void;
  /** Changes when the underlying issue changes, allowing a dismissed issue to be shown again. */
  revision?: string | number;
  busyActionId?: string | null;
  actionError?: string | null;
}

type NoticeEntry = ActionableNotice & { dismissed?: boolean; dismissedRevision?: string | number };

const listeners = new Set<() => void>();
const entries = new Map<string, NoticeEntry>();
let snapshot: readonly ActionableNotice[] = [];

function publish() {
  snapshot = [...entries.values()]
    .filter((entry) => !entry.dismissed || entry.dismissedRevision !== entry.revision)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const listener of [...listeners]) listener();
}

export function subscribeActionableNotices(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActionableNotices(): readonly ActionableNotice[] {
  return snapshot;
}

export function upsertActionableNotice(notice: ActionableNotice) {
  const previous = entries.get(notice.id);
  const changedRevision = previous?.revision !== notice.revision;
  entries.set(notice.id, {
    ...previous,
    ...notice,
    busyActionId: changedRevision ? null : (previous?.busyActionId ?? notice.busyActionId ?? null),
    actionError: changedRevision ? null : (previous?.actionError ?? notice.actionError ?? null),
    dismissed: changedRevision ? false : previous?.dismissed,
    dismissedRevision: changedRevision ? undefined : previous?.dismissedRevision,
  });
  publish();
}

export function clearActionableNotice(id: string) {
  if (!entries.delete(id)) return;
  publish();
}

export function dismissActionableNotice(id: string) {
  const entry = entries.get(id);
  if (!entry || !entry.dismissible) return;
  entry.dismissed = true;
  entry.dismissedRevision = entry.revision;
  entry.onDismiss?.();
  publish();
}

export async function runActionableNoticeAction(noticeId: string, actionId: string) {
  const entry = entries.get(noticeId);
  const action = entry?.actions.find((candidate) => candidate.id === actionId);
  if (!entry || !action || entry.busyActionId) return;
  entry.busyActionId = actionId;
  entry.actionError = null;
  publish();
  try {
    await action.run();
  } catch (error) {
    const current = entries.get(noticeId);
    if (current) current.actionError = error instanceof Error ? error.message : String(error);
  } finally {
    const current = entries.get(noticeId);
    if (current?.busyActionId === actionId) current.busyActionId = null;
    publish();
  }
}
