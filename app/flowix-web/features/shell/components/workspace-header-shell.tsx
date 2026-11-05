'use client';

import { useColumnEnvironment } from './column-environment';

import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { WorkspaceHeaderModel } from '@features/workspace/public/header-api';

export const WORK_COLUMN_TITLEBAR_GRADIENT = 'var(--titlebar-gradient)';

export interface WorkspaceHeaderShellProps extends ComponentPropsWithRef<'div'> {
  as?: 'div' | 'header';
  isWindows: boolean;
  reserveWindowsControls?: boolean;
  showTrafficLightSpacer?: boolean;
  header?: WorkspaceHeaderModel;
  children: ReactNode;
}

/** Both columns share platform geometry, drag region and background layers. */
export function WorkspaceHeaderShell({
  as: Tag = 'div', isWindows, reserveWindowsControls = true,
  showTrafficLightSpacer = false, header, className = '', style, children, ...domProps
}: WorkspaceHeaderShellProps) {
  const environment = useColumnEnvironment();
  if (environment) {
    reserveWindowsControls = environment.index === 1 || !environment.browserVisible;
    showTrafficLightSpacer = environment.index === 0
      && environment.sidebarHidden && !environment.navigationVisible;
  }
  const skin = header?.chrome === 'agent' ? 'agent-surface-titlebar' : header?.chrome === 'media' ? 'media-surface-titlebar' : '';
  return <Tag {...domProps} data-tauri-drag-region data-header-style={header?.chrome}
    className={`work-column-titlebar relative z-[50] flex h-[var(--window-titlebar-height)] min-h-[var(--window-titlebar-height)] shrink-0 select-none items-center pl-1 ${isWindows && reserveWindowsControls ? 'pr-[var(--window-controls-width)]' : isWindows ? 'pr-0' : ''} ${skin} ${className}`}
    style={{ ...style, ...(header ? {
      backgroundColor: header.backgroundColor,
      backgroundImage: header.gradient ? WORK_COLUMN_TITLEBAR_GRADIENT : 'none',
    } : {}) }}>
    {!isWindows && showTrafficLightSpacer && <div aria-hidden="true" className="h-full w-[80px] shrink-0" />}
    {children}
  </Tag>;
}
