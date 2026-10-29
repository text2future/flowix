'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PROPERTY_ICON_OPTIONS } from '@features/document/public/property-display-api';

/**
 * 文件树专用的笔记图标 picker（样式对齐 IconValueInput 的弹层）。
 *
 * 刻意不复用 IconValueInput + Popover 的实现：树行（虚拟列表 + ContextMenu）
 * 宿主环境里，共享弹层选项的 React 合成 click 在真实 WKWebView 中不触发
 * （jsdom 无法复现），因此这里改为：
 * - 选项点击用原生事件委托（addEventListener），不经过 React 合成事件；
 * - 弹层仍 portal 到 body 保证不被树的 overflow 裁剪，定位自行计算。
 */
export function TreeIconPicker({
  value,
  onChange,
  children,
}: {
  /** 当前图标值（空串表示未设置）。 */
  value: string;
  onChange: (next: string) => void;
  /** 触发器内容（图标或默认文件图标）。 */
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 选项点击：原生事件委托，绕开 React 合成事件链路。
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest<HTMLButtonElement>('button[data-icon-option]')
        : null;
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      onChangeRef.current(button.dataset.iconOption ?? '');
      setOpen(false);
    };
    panel.addEventListener('click', handleClick);
    return () => panel.removeEventListener('click', handleClick);
  }, [open]);

  // 点击弹层与触发器之外关闭；Escape 关闭。
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // 固定定位：默认贴触发器下方，放不下翻到上方，并夹在视口内；滚动/缩放跟随。
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 4 && rect.top - height - 6 >= 4) {
        top = rect.top - height - 6;
      }
      top = Math.max(4, Math.min(top, window.innerHeight - height - 4));
      const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4));
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  const toggleOpen = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setOpen((current) => !current);
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('document.properties.icon.placeholder')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggleOpen}
        onDoubleClick={(event: ReactMouseEvent<HTMLButtonElement>) => event.stopPropagation()}
        onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => event.stopPropagation()}
        className={'relative flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)] [[data-theme="dark"]_&]:text-[var(--foreground)] [[data-theme="mist"]_&]:text-[var(--foreground)]'}
      >
        {children}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('document.properties.icon.placeholder')}
          className="flowix-tree-icon-picker fixed z-[150] w-[280px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
          style={{ top: -9999, left: -9999 }}
          onClick={(event) => event.stopPropagation()}
          // 关键：阻止 pointerdown 沿 React 组件树冒泡到树行。
          // 树行会在 pointerdown 上 setPointerCapture，一旦捕获，后续 click 会被
          // 重定向到树行，导致选项收不到 click（onChange 不触发）且文档被打开。
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="max-h-[240px] overflow-y-auto [scrollbar-gutter:stable]">
            <div className="grid grid-cols-5 gap-1">
              {PROPERTY_ICON_OPTIONS.map((option) => {
                const active = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    data-icon-option={option.value}
                    aria-label={option.label}
                    title={option.label}
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                      active
                        ? 'border-[var(--primary)] bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]'
                        : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--muted)]/60',
                    )}
                  >
                    <img
                      src={option.src}
                      alt=""
                      className="h-6 w-6 object-contain"
                      draggable={false}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
