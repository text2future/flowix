import type { ReactNode, Ref } from 'react';

import type { CollectionPanelControls } from '@features/collection/public/panel-api';
import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import type { CollectionActionsHost } from '@shared/ui/collection-actions';

import type { FileDisplayIdentity } from '@/lib/file-display-registry';

/**
 * 表格集合视图的对外契约。它被集合外壳、编辑器内嵌节点、独立打开的表格文档三种
 * 宿主共用，改这里等于改三处调用方，所以单独放一个文件：实现体里两千行的状态与
 * JSX 与这份契约无关，混在一起只会让人误以为改契约需要读实现。
 */
export interface TableDocumentViewProps {
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  filePath: string;
  /** Stable runtime identity for the table file; survives a rename. */
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId: string | null;
  expectedCollectionId?: string | null;
  initialViewId?: string | null;
  onActiveViewChange?: (viewId: string) => void;
  /** Collection shells own the only tab bar and receive note dataset actions here. */
  showNavigation?: boolean;
  collectionActionsHost?: CollectionActionsHost;
  /** Open the collection's asset filter from the shared dataset menu. */
  onOpenAssetFilter?: () => void;
  assetFilterMenu?: ReactNode;
  /** Collection shell routing hook for keeping the note filter action visible while it is open. */
  onDatasetFilterOpenChange?: (open: boolean) => void;
  panelControlsRef?: Ref<CollectionPanelControls>;
  /** 是否渲染 nav 里的集合名称；外壳自带标题头时置 false，避免一个集合出现两个名字。 */
  showNavTitle?: boolean;
  editable?: boolean;
  canCreateFields?: boolean;
  canCreateRecords?: boolean;
  /** Show the explicit “关联笔记” entry independently from generic record creation controls. */
  showAssociateNoteAction?: boolean;
  canDeleteViews?: boolean;
  /** The table is rendered as a node inside the Markdown editor. */
  embeddedInEditor?: boolean;
  /** Removes the reference node when an embedded table cannot be loaded. */
  onRemoveReference?: () => void;
  /** Renders title bar actions and receives the table dataset action. */
  trailingActions?: (datasetAction: ReactNode) => ReactNode;
  /** Called after the table file has been renamed. */
  onFilePathChange?: (filePath: string) => void;
  /** 集合头图是否展示（无图时是占位）；null = 该入口不提供头图开关。 */
  bannerVisible?: boolean | null;
  /** 切换头图显示 / 隐藏（写入集合属性 banner_hidden）。 */
  onToggleBannerVisibility?: () => void;
  /**
   * 整页滚动模式：集合外壳把「头图 → 标题 → tab 条 → 列表」放进同一个滚动容器，
   * 此时 nav 吸顶（钉在头部）、各层容器不再裁切，表头 thead 吸在 nav 下沿，
   * 宽表的横向滚动交给外层滚动容器承担。
   */
  pageScroll?: boolean;
  /**
   * 当前激活视图的版式（table / gallery / calendar / kanban）与它需要的横向宽度。
   * 外壳用它决定整页滚动轨道要多宽：只有表格需要横向余量（宽表整页横滚），
   * 画廊/日历是流式内容，撑宽了会凭空多出一条横向滚动条。
   */
  onActiveLayoutChange?: (layout: string | null, contentWidth: number | null) => void;
  /**
   * 集合外壳里打开时给列表区域挂上统一右键菜单（新建笔记 / 导入笔记 .md）。
   * 独立打开的表格文档不传，避免在非集合场景多出一层菜单。
   */
  collectionAreaMenu?: boolean;
}
