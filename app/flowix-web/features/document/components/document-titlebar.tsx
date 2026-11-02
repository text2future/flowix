'use client';

import { Link2 } from 'lucide-react';

import { WorkColumnTitlebar } from '@features/shell/components/work-column-titlebar';
import { WorkColumnTitlebarNavigation } from '@features/shell/components/work-column-titlebar-navigation';
import { WorkColumnBrowserExpandButton, WorkspaceHeaderIdentity, useWorkspaceHeader } from '@features/shell/public/work-column-api';
import { CollectionDisplayMenu } from '@features/collection/public/title-api';
import {
  TITLEBAR_ICON_BUTTON_CLASS,
  TITLEBAR_ICON_BUTTON_FRAMELESS_CLASS,
} from '@shared/ui/titlebar-icon-button';
import type { DocumentTitlebarProps } from './document-titlebar-model';
import { ExternalTitlebarBadge, SurfaceHeaderIcon, MediaActions } from './document-titlebar-controls';
import { DocumentTitlebarActions } from './document-titlebar-actions';
import {
  AgentThreadCardFullscreenExitButton, AgentThreadCardFullscreenMoreMenu,
  AgentThreadCardFullscreenIdentity,
} from './agent-thread-card-titlebar';

/** Shared behavior and content; platforms only select native window geometry. */
export function DocumentTitlebar({
  platform,
  webAddressBarVisible = false,
  onToggleWebAddressBar,
  reserveWindowsControls = true,
  surfaceChrome = 'document',
  headerBackgroundColor,
  document: { target },
  sidebar,
  navigation,
  contentCapabilities,
  actions,
  mediaActions,
  folderCollectionViewType,
  collectionDisplay,
  showEditorFontSwitcher = false,
  showEditorModeToggle = false,
  editorMode = 'rich',
  onSetEditorMode,
}: DocumentTitlebarProps & { platform: 'mac' | 'windows' }) {
  const isWindows = platform === 'windows';
  const { fullscreen, model: header } = useWorkspaceHeader('main-third', {
    chrome: surfaceChrome, backgroundColor: headerBackgroundColor, collection: Boolean(collectionDisplay),
  });
  const isMediaSurface = surfaceChrome === 'media';
  const hasCollectionDisplayActionMenu = isMediaSurface ? Boolean(mediaActions) : Boolean(target);
  const iconButtonClass = TITLEBAR_ICON_BUTTON_CLASS;

  return <WorkColumnTitlebar isWindows={isWindows} reserveWindowsControls={reserveWindowsControls}
    showTrafficLightSpacer={sidebar.hidden && !sidebar.noteNavigationVisible}
    header={header}>
    <WorkColumnTitlebarNavigation sidebar={sidebar} navigation={navigation}>
      {header.showIdentity && (navigation.title || navigation.icon) &&
        <WorkspaceHeaderIdentity title={navigation.title} className="ml-1 max-w-[320px] font-medium"
          icon={<SurfaceHeaderIcon icon={navigation.icon} web={Boolean(onToggleWebAddressBar)} />} />}

    </WorkColumnTitlebarNavigation>
    <AgentThreadCardFullscreenIdentity />
    <div data-tauri-drag-region className="ml-auto flex shrink-0 items-center gap-1 pr-2">
      <AgentThreadCardFullscreenExitButton className="agent-thread-card-fullscreen-exit-btn" />
      {header.showSurfaceActions && target && <ExternalTitlebarBadge target={target} />}
      <WorkColumnBrowserExpandButton iconButtonClass={TITLEBAR_ICON_BUTTON_FRAMELESS_CLASS} />
      {/* 文件夹入口没有文档/媒体操作菜单时，集合显示偏好单独放在标题栏。 */}
      {header.showSurfaceActions && collectionDisplay && !hasCollectionDisplayActionMenu && <CollectionDisplayMenu
        indexPath={collectionDisplay.indexPath}
        iconButtonClass={iconButtonClass}
      />}
      {header.showSurfaceActions && onToggleWebAddressBar && <button
        type="button"
        className={iconButtonClass}
        aria-label={webAddressBarVisible ? '隐藏网址条' : '显示网址条'}
        title={webAddressBarVisible ? '隐藏网址条' : '显示网址条'}
        aria-expanded={webAddressBarVisible}
        onClick={onToggleWebAddressBar}
      ><Link2 className="h-4 w-4" /></button>}
      {target && !isMediaSurface && <DocumentTitlebarActions
        key={`${target.fileIdentity.displayId}:${target.fileIdentity.path}`}
        target={target}
        visible={header.showSurfaceActions}
        iconButtonClass={iconButtonClass}
        capabilities={contentCapabilities}
        actions={actions}
        folderCollectionViewType={folderCollectionViewType}
        collectionDisplayIndexPath={collectionDisplay?.indexPath}
        showEditorFontSwitcher={showEditorFontSwitcher}
        showEditorModeToggle={showEditorModeToggle}
        editorMode={editorMode}
        onSetEditorMode={onSetEditorMode}
      />}
      {fullscreen && <AgentThreadCardFullscreenMoreMenu iconButtonClass={iconButtonClass} />}
      {header.showSurfaceActions && isMediaSurface && mediaActions && <MediaActions
        iconButtonClass={iconButtonClass}
        collectionDisplayIndexPath={collectionDisplay?.indexPath}
        {...mediaActions}
      />}
    </div>
  </WorkColumnTitlebar>;
}
