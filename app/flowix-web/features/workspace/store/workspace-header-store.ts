import { create } from 'zustand';
import type { AgentTypeKey } from '@/types/agent';
import type { WorkspaceColumnId } from '../model/surface-contract';

export interface WorkspaceHeaderFullscreenInfo {
  title: string;
  typeKey: AgentTypeKey;
  instanceId: string | null;
  threadId: string | null;
}
type Owned<T> = { owner: object; value: T };
interface HeaderState {
  fullscreen: Partial<Record<WorkspaceColumnId, Owned<WorkspaceHeaderFullscreenInfo>>>;
  scrolled: Partial<Record<WorkspaceColumnId, Owned<boolean>>>;
}
const useHeaderState = create<HeaderState>(() => ({ fullscreen: {}, scrolled: {} }));

/** Ownership prevents an outgoing view from clearing its replacement's header. */
export function reportWorkspaceHeaderFullscreen(host: WorkspaceColumnId, owner: object, value: WorkspaceHeaderFullscreenInfo) {
  const previous = useHeaderState.getState().fullscreen[host];
  if (previous?.owner === owner && Object.entries(value).every(([key, entry]) => previous.value[key as keyof WorkspaceHeaderFullscreenInfo] === entry)) return;
  useHeaderState.setState((state) => ({ fullscreen: { ...state.fullscreen, [host]: { owner, value } } }));
}
export function clearWorkspaceHeaderFullscreen(host: WorkspaceColumnId, owner: object) {
  if (useHeaderState.getState().fullscreen[host]?.owner !== owner) return;
  useHeaderState.setState((state) => ({ fullscreen: { ...state.fullscreen, [host]: undefined } }));
}
export function reportWorkspaceHeaderScrolled(host: WorkspaceColumnId, owner: object, value: boolean) {
  const previous = useHeaderState.getState().scrolled[host];
  if (previous?.owner === owner && previous.value === value) return;
  useHeaderState.setState((state) => ({ scrolled: { ...state.scrolled, [host]: { owner, value } } }));
}
export function clearWorkspaceHeaderScrolled(host: WorkspaceColumnId, owner: object) {
  if (useHeaderState.getState().scrolled[host]?.owner !== owner) return;
  useHeaderState.setState((state) => ({ scrolled: { ...state.scrolled, [host]: undefined } }));
}
export function useWorkspaceHeaderFullscreen(host: WorkspaceColumnId) {
  return useHeaderState((state) => state.fullscreen[host]?.value ?? null);
}
export function getWorkspaceHeaderFullscreen(host: WorkspaceColumnId) {
  return useHeaderState.getState().fullscreen[host]?.value ?? null;
}
export function getWorkspaceHeaderScrolled(host: WorkspaceColumnId) {
  return useHeaderState.getState().scrolled[host]?.value ?? false;
}
export function useWorkspaceHeaderScrolled(host: WorkspaceColumnId) {
  return useHeaderState((state) => state.scrolled[host]?.value ?? false);
}
