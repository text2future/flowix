import { lazy, Suspense } from 'react';
import type { WorkspaceColumnId } from '@features/workspace/public/host-api';
import { useWorkspaceHeaderFullscreen } from '@features/workspace/public/header-api';

const LazyFullscreenExitButton = lazy(async () => {
  const module = await import('./agent-thread-card-titlebar');
  return { default: module.AgentThreadCardFullscreenExitButton };
});
const LazyFullscreenIdentity = lazy(async () => {
  const module = await import('./agent-thread-card-titlebar');
  return { default: module.AgentThreadCardFullscreenIdentity };
});
const LazyFullscreenMoreMenu = lazy(async () => {
  const module = await import('./agent-thread-card-titlebar');
  return { default: module.AgentThreadCardFullscreenMoreMenu };
});

export type AgentThreadCardFullscreenHost = WorkspaceColumnId;

export function useAgentThreadCardFullscreenActive(host: AgentThreadCardFullscreenHost = 'column-1'): boolean {
  return useWorkspaceHeaderFullscreen(host) !== null;
}

export function useFullscreenAgentThreadCardInfo(host: AgentThreadCardFullscreenHost = 'column-1') {
  return useWorkspaceHeaderFullscreen(host);
}

export function AgentThreadCardFullscreenExitButton({
  className,
  host = 'column-1',
}: {
  className: string;
  host?: AgentThreadCardFullscreenHost;
}) {
  if (!useAgentThreadCardFullscreenActive(host)) return null;
  return <Suspense fallback={null}><LazyFullscreenExitButton className={className} host={host} /></Suspense>;
}

export function AgentThreadCardFullscreenIdentity({
  host = 'column-1',
}: {
  host?: AgentThreadCardFullscreenHost;
} = {}) {
  if (!useAgentThreadCardFullscreenActive(host)) return null;
  return <Suspense fallback={null}><LazyFullscreenIdentity host={host} /></Suspense>;
}

export function AgentThreadCardFullscreenMoreMenu({
  iconButtonClass,
  host = 'column-1',
}: {
  iconButtonClass: string;
  host?: AgentThreadCardFullscreenHost;
}) {
  if (!useAgentThreadCardFullscreenActive(host)) return null;
  return <Suspense fallback={null}><LazyFullscreenMoreMenu iconButtonClass={iconButtonClass} host={host} /></Suspense>;
}
