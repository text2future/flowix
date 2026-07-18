import { Check, ChevronDown, FileText, Globe, X } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { WindowPosition, WindowRegion, WindowTab } from '@platform/tauri/client';
import { useI18n } from '@features/i18n';
import { displayTitleFromFilename } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import {
  expandScreenRect,
  isOutsideRect,
  FLOWIX_TAB_DRAG_TYPE,
  tabDropBeforeId,
  tabDragMode,
  tearOffWindowPosition,
  toScreenRect,
  type Point,
  type ScreenRect,
} from './tab-tear-off';

interface TabStripProps {
  tabs: WindowTab[];
  selectedTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onDetach: (
    tabId: string,
    position: WindowPosition,
    dragId: string,
  ) => void;
  onTabDragStart: (tabId: string, dragId: string) => void;
  onTabDragCancel: (tabId: string, dragId: string) => void;
  onReorder: (tabId: string, beforeTabId: string | null) => void;
  onRegionChange: (region: WindowRegion) => void;
  mergePreview: WindowTab | null;
}

interface TabDragState {
  tabId: string;
  dragId: string;
  headerBounds: ScreenRect;
  pointerOffsetInWindow: Point;
  lastScreenPoint: Point;
  viewportScreenX: number;
  beforeTabId: string | null;
}

interface TabDragPointerPayload {
  dragId: string;
  screenX: number;
}

const WINDOW_TAB_DRAG_POINTER_EVENT = 'flowix:window-tab-drag-pointer';
const TAB_TEAR_OFF_THRESHOLD_RATIO = 0.5;
const TAB_LAYOUT_ANIMATION_DURATION = 180;
const TAB_LAYOUT_ANIMATION_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

interface TabLayoutSnapshot {
  left: number;
  width: number;
}

export function TabStrip({
  tabs,
  selectedTabId,
  onSelect,
  onClose,
  onDetach,
  onTabDragStart,
  onTabDragCancel,
  onReorder,
  onRegionChange,
  mergePreview,
}: TabStripProps) {
  const { t } = useI18n();
  const dragMode = tabDragMode(tabs.length);
  const showTabMenu = tabs.length >= 2;
  const containerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const tabDragRef = useRef<TabDragState | null>(null);
  const dragImageRef = useRef<HTMLElement | null>(null);
  const updateDropTargetRef = useRef<(drag: TabDragState, pointerClientX: number) => void>(() => {});
  const previousTabLayoutRef = useRef(new Map<string, TabLayoutSnapshot>());
  const tabLayoutAnimationsRef = useRef(new Map<string, Animation>());
  const lastRegionRef = useRef<WindowRegion | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropBeforeTabId, setDropBeforeTabId] = useState<string | null>(null);
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const lastDropTargetTabId = draggingTabId
    ? [...tabs].reverse().find((tab) => tab.id !== draggingTabId)?.id ?? null
    : null;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const strip = stripRef.current;
    if (!container || !strip) return;

    const measure = () => {
      const rect = container.getBoundingClientRect();
      const region = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      const previous = lastRegionRef.current;
      if (region.width > 0 && region.height > 0 && (
        !previous
        || previous.x !== region.x
        || previous.y !== region.y
        || previous.width !== region.width
        || previous.height !== region.height
      )) {
        lastRegionRef.current = region;
        onRegionChange(region);
      }
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [onRegionChange, tabs]);

  useLayoutEffect(() => {
    if (!selectedTabId) return;
    tabRefs.current.get(selectedTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedTabId]);

  useLayoutEffect(() => {
    for (const animation of tabLayoutAnimationsRef.current.values()) animation.cancel();
    tabLayoutAnimationsRef.current.clear();

    const previous = previousTabLayoutRef.current;
    const current = new Map<string, TabLayoutSnapshot>();
    for (const tab of tabs) {
      const rect = tabRefs.current.get(tab.id)?.getBoundingClientRect();
      if (rect) current.set(tab.id, { left: rect.left, width: rect.width });
    }

    const addedTabIds = tabs
      .map((tab) => tab.id)
      .filter((tabId) => !previous.has(tabId));
    const removedTabIds = [...previous.keys()]
      .filter((tabId) => !current.has(tabId));
    const shouldAnimate = previous.size > 0
      && (addedTabIds.length > 0 || removedTabIds.length > 0)
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (shouldAnimate) {
      const added = new Set(addedTabIds);
      for (const tab of tabs) {
        const element = tabRefs.current.get(tab.id);
        const next = current.get(tab.id);
        if (!element || !next || typeof element.animate !== 'function') continue;

        let animation: Animation | null = null;
        if (added.has(tab.id)) {
          animation = element.animate(
            [
              { opacity: 0, transform: 'scale(0.96)' },
              { opacity: 1, transform: 'scale(1)' },
            ],
            {
              duration: TAB_LAYOUT_ANIMATION_DURATION,
              easing: TAB_LAYOUT_ANIMATION_EASING,
            },
          );
        } else {
          const old = previous.get(tab.id);
          if (!old) continue;
          const deltaX = old.left - next.left;
          const scaleX = next.width > 0 ? old.width / next.width : 1;
          if (Math.abs(deltaX) < 0.5 && Math.abs(scaleX - 1) < 0.005) continue;
          animation = element.animate(
            [
              {
                transform: `translateX(${deltaX}px) scaleX(${scaleX})`,
                transformOrigin: 'left center',
              },
              { transform: 'translateX(0) scaleX(1)', transformOrigin: 'left center' },
            ],
            {
              duration: TAB_LAYOUT_ANIMATION_DURATION,
              easing: TAB_LAYOUT_ANIMATION_EASING,
            },
          );
        }

        tabLayoutAnimationsRef.current.set(tab.id, animation);
        void animation.finished.catch(() => {}).finally(() => {
          if (tabLayoutAnimationsRef.current.get(tab.id) === animation) {
            tabLayoutAnimationsRef.current.delete(tab.id);
          }
        });
      }
    }

    previousTabLayoutRef.current = current;
  }, [tabs]);

  useEffect(() => () => {
    dragImageRef.current?.remove();
    dragImageRef.current = null;
    for (const animation of tabLayoutAnimationsRef.current.values()) animation.cancel();
    tabLayoutAnimationsRef.current.clear();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = Math.min(index + 1, tabs.length - 1);
    else if (event.key === 'ArrowLeft') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    onSelect(tabs[next].id);
  };

  const titleFor = (tab: WindowTab) => (
    tab.target.kind === 'memo' ? displayTitleFromFilename(tab.title) : tab.title
  );

  const handleDragStart = (event: DragEvent<HTMLDivElement>, tabId: string) => {
    if (dragMode !== 'tear_off') {
      event.preventDefault();
      return;
    }
    if ((event.target as HTMLElement).closest('[data-tab-close]')) {
      event.preventDefault();
      return;
    }
    const header = event.currentTarget.closest<HTMLElement>('[data-tab-window-header]');
    if (!header) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    // WebKit requires drag data before it will keep emitting native drag
    // events. Its default drag image is the actual tab, which gives us the
    // same cursor-following affordance as a browser tab.
    const tab = tabs.find((candidate) => candidate.id === tabId);
    event.dataTransfer.setData(FLOWIX_TAB_DRAG_TYPE, tabId);
    event.dataTransfer.setData('text/plain', tab ? titleFor(tab) : tabId);
    const tabBounds = event.currentTarget.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const dragImage = document.createElement('canvas');
    dragImage.width = Math.max(1, Math.round(tabBounds.width * pixelRatio));
    dragImage.height = Math.max(1, Math.round(tabBounds.height * pixelRatio));
    dragImage.style.position = 'fixed';
    dragImage.style.left = '-10000px';
    dragImage.style.top = '-10000px';
    dragImage.style.width = `${tabBounds.width}px`;
    dragImage.style.height = `${tabBounds.height}px`;
    dragImage.style.pointerEvents = 'none';
    document.body.appendChild(dragImage);

    const colorProbe = document.createElement('span');
    colorProbe.style.color = 'var(--foreground)';
    colorProbe.style.backgroundColor = 'var(--document-bg)';
    colorProbe.style.borderColor = 'var(--border)';
    colorProbe.style.position = 'fixed';
    colorProbe.style.left = '-10000px';
    document.body.appendChild(colorProbe);
    const previewColors = getComputedStyle(colorProbe);
    const foreground = previewColors.color;
    const background = previewColors.backgroundColor;
    const border = previewColors.borderColor;
    colorProbe.remove();

    const context = dragImage.getContext('2d');
    if (context) {
      const width = tabBounds.width;
      const height = tabBounds.height;
      const radius = Math.min(8, height / 2);
      context.scale(pixelRatio, pixelRatio);
      // Bake the alpha into the bitmap. WebKit no longer has to snapshot a
      // transitioning DOM tab, so every drag begins with identical pixels.
      context.globalAlpha = 0.6;
      context.beginPath();
      context.roundRect(0.5, 0.5, width - 1, height - 1, radius);
      context.fillStyle = background;
      context.fill();
      context.strokeStyle = border;
      context.lineWidth = 1;
      context.stroke();

      context.fillStyle = foreground;
      context.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      context.textBaseline = 'middle';
      context.save();
      context.beginPath();
      context.rect(12, 0, Math.max(0, width - 42), height);
      context.clip();
      context.fillText(tab ? titleFor(tab) : tabId, 12, height / 2);
      context.restore();

      const closeX = width - 16;
      const closeY = height / 2;
      context.lineWidth = 1.25;
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(closeX - 3, closeY - 3);
      context.lineTo(closeX + 3, closeY + 3);
      context.moveTo(closeX + 3, closeY - 3);
      context.lineTo(closeX - 3, closeY + 3);
      context.strokeStyle = foreground;
      context.stroke();
    }
    dragImageRef.current?.remove();
    dragImageRef.current = dragImage;
    event.dataTransfer.setDragImage(
      dragImage,
      event.clientX - tabBounds.left,
      event.clientY - tabBounds.top,
    );
    const screenPoint = { x: event.screenX, y: event.screenY };
    const headerClientBounds = header.getBoundingClientRect();
    const headerBounds = toScreenRect(headerClientBounds, event);
    const tearOffThreshold = headerClientBounds.height * TAB_TEAR_OFF_THRESHOLD_RATIO;
    const dragId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tabDragRef.current = {
      tabId,
      dragId,
      headerBounds: expandScreenRect(headerBounds, tearOffThreshold),
      pointerOffsetInWindow: { x: event.clientX, y: event.clientY },
      lastScreenPoint: screenPoint,
      viewportScreenX: event.screenX - event.clientX,
      beforeTabId: tabs[tabs.findIndex((candidate) => candidate.id === tabId) + 1]?.id ?? null,
    };
    onTabDragStart(tabId, dragId);
    setHoveredTabId(null);
    setDraggingTabId(tabId);
    setDropBeforeTabId(tabDragRef.current.beforeTabId);
  };

  const updateDropTarget = (drag: TabDragState, pointerClientX: number) => {
    const beforeTabId = tabDropBeforeId(
      tabs.flatMap((tab) => {
        const rect = tabRefs.current.get(tab.id)?.getBoundingClientRect();
        return rect ? [{ id: tab.id, left: rect.left, width: rect.width }] : [];
      }),
      drag.tabId,
      pointerClientX,
    );
    if (drag.beforeTabId !== beforeTabId) {
      drag.beforeTabId = beforeTabId;
      setDropBeforeTabId(beforeTabId);
    }
  };
  updateDropTargetRef.current = updateDropTarget;

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<TabDragPointerPayload>(WINDOW_TAB_DRAG_POINTER_EVENT, (event) => {
      const drag = tabDragRef.current;
      if (!drag || event.payload.dragId !== drag.dragId) return;
      updateDropTargetRef.current(drag, event.payload.screenX - drag.viewportScreenX);
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleStripDragOver = (event: DragEvent<HTMLDivElement>) => {
    const drag = tabDragRef.current;
    // WebKit may hide custom DataTransfer types during dragover. The local
    // drag session is the reliable signal that this strip owns the drag.
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    updateDropTarget(drag, event.clientX);
  };

  const handleDrag = (event: DragEvent<HTMLDivElement>) => {
    const drag = tabDragRef.current;
    if (!drag) return;
    // Some WebViews report an all-zero synthetic final drag event. Preserve
    // the last real point so releasing outside the Webview remains reliable.
    if (event.screenX !== 0 || event.screenY !== 0) {
      drag.lastScreenPoint = { x: event.screenX, y: event.screenY };
      // Tauri's macOS WebView does not always dispatch dragover on elements
      // marked as native drag regions. Source drag events remain continuous,
      // so use them as a coordinate fallback for reordering.
      updateDropTarget(drag, event.screenX - drag.viewportScreenX);
    }
  };

  const handleDragEnd = (event: DragEvent<HTMLDivElement>) => {
    const drag = tabDragRef.current;
    tabDragRef.current = null;
    dragImageRef.current?.remove();
    dragImageRef.current = null;
    setHoveredTabId(null);
    setDraggingTabId(null);
    setDropBeforeTabId(null);
    if (!drag) return;

    const dropPoint = event.screenX !== 0 || event.screenY !== 0
      ? { x: event.screenX, y: event.screenY }
      : drag.lastScreenPoint;
    if (!isOutsideRect(dropPoint, drag.headerBounds)) {
      onTabDragCancel(drag.tabId, drag.dragId);
      onReorder(drag.tabId, drag.beforeTabId);
      return;
    }
    const position = tearOffWindowPosition(dropPoint, drag.pointerOffsetInWindow);
    onDetach(drag.tabId, position, drag.dragId);
  };

  return (
    <div
      ref={containerRef}
      data-tauri-drag-region
      className="relative flex h-full min-w-0 flex-1 items-center gap-1"
    >
      {mergePreview && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-50 rounded-lg bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]" />
      )}
      {showTabMenu && (
        <div className="w-8 shrink-0 [-webkit-app-region:no-drag]">
          <DropdownMenu className="[-webkit-app-region:no-drag]">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Show all open tabs"
                title="Show all open tabs"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] [-webkit-app-region:no-drag]"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="bottom"
              sideOffset={4}
              className="max-h-[min(420px,calc(100vh-16px))] w-[280px] overflow-y-auto p-1"
            >
              <DropdownMenuLabel className="px-2 py-1 text-xs font-medium text-[var(--muted-foreground)]">
                {t('tabWindow.all')}
              </DropdownMenuLabel>
              <div className="space-y-0.5">
                {tabs.map((tab) => {
                  const selected = tab.id === selectedTabId;
                  const title = titleFor(tab);
                  return (
                    <DropdownMenuItem
                      key={tab.id}
                      title={title}
                      onClick={() => onSelect(tab.id)}
                      className="gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--muted-foreground)]">
                        {tab.icon ? (
                          <span className="text-sm leading-none">{tab.icon}</span>
                        ) : tab.target.kind === 'web' ? (
                          <Globe className="h-3.5 w-3.5" />
                        ) : (
                          <FileText className="h-3.5 w-3.5" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />}
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open content"
        data-tauri-drag-region
        onDragOver={handleStripDragOver}
        className="relative flex h-full min-w-0 flex-1 items-center gap-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === selectedTabId;
          const title = titleFor(tab);
          return (
            <div
              key={tab.id}
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element);
                else tabRefs.current.delete(tab.id);
              }}
              draggable={dragMode === 'tear_off'}
              aria-grabbed={draggingTabId === tab.id}
              onPointerEnter={() => {
                if (!tabDragRef.current) setHoveredTabId(tab.id);
              }}
              onPointerLeave={() => {
                setHoveredTabId((current) => current === tab.id ? null : current);
              }}
              onDragStart={(event) => handleDragStart(event, tab.id)}
              onDrag={handleDrag}
              onDragEnd={handleDragEnd}
              className={`group relative flex h-8 min-w-[60px] max-w-[150px] shrink basis-[150px] cursor-default items-center border text-xs transition-[color,background-color,border-color,opacity] [-webkit-app-region:no-drag] ${draggingTabId === tab.id ? 'opacity-45' : ''} ${selected ? 'tab-window-tab--active rounded-t-xl border-[var(--border)] border-b-transparent bg-[var(--document-bg)] text-[var(--foreground)]' : `rounded-lg border-transparent ${hoveredTabId === tab.id && !draggingTabId ? 'bg-[var(--muted)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'}`}`}
            >
              {draggingTabId && dropBeforeTabId === tab.id && (
                <span aria-hidden="true" className="pointer-events-none absolute -left-px top-1 bottom-1 z-20 w-0.5 rounded-full bg-[var(--brand)]" />
              )}
              {draggingTabId && dropBeforeTabId === null && lastDropTargetTabId === tab.id && (
                <span aria-hidden="true" className="pointer-events-none absolute -right-px top-1 bottom-1 z-20 w-0.5 rounded-full bg-[var(--brand)]" />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={title}
                className="min-w-0 flex-1 cursor-default truncate py-2 pl-3 text-left [-webkit-app-region:no-drag]"
                onClick={() => onSelect(tab.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
              >
                {title}
              </button>
              <button type="button" draggable={false} data-tab-close aria-label={`Close ${title}`} className="mr-2 flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded-full opacity-60 hover:bg-[color-mix(in_oklch,var(--foreground)_14%,transparent)] hover:opacity-100 [-webkit-app-region:no-drag]" onClick={() => onClose(tab.id)}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
