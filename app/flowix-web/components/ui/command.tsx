'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

/**
 * Command palette (shadcn UI 风格, 基于 cmdk).
 *
 * 与 components/ui/dialog.tsx 一样, CommandDialog 使用 react portal
 * 渲染到 document.body, 并复用 flowix-fade-* / flowix-dialog-* 动画。
 * 配色 token 全部走 var(--*) 以适配 light / dark / rock 三套主题。
 */

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-xl bg-[var(--popover)] text-[var(--popover-foreground)]',
      className,
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  /** 默认 true; 命令面板场景通常关闭 — 避免命令面板把整个视口压暗。
   *  关闭后仍保留"点击空白处关闭"的隐形捕获层, 只是没有可见蒙层。 */
  showOverlay?: boolean;
  /** 默认 true; 是否在右上角渲染关闭按钮 */
  showCloseButton?: boolean;
}

const EXIT_ANIMATION_MS = 300;

function CommandDialog({
  open,
  onOpenChange,
  children,
  className,
  showOverlay = true,
  showCloseButton = false,
}: CommandDialogProps) {
  // 与 dialog.tsx 一致: 独立的 mounted / visible 状态让退出动画跑完再卸载。
  const [mounted, setMounted] = React.useState(open);
  const [visible, setVisible] = React.useState(open);

  React.useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const timer = setTimeout(() => setMounted(false), EXIT_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // Esc 关闭
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!mounted) return null;

  return createPortal(
    <>
      {showOverlay ? (
        <div
          className={cn(
            'fixed inset-0 z-50 bg-black/50',
            visible ? 'flowix-fade-enter' : 'flowix-fade-leave',
          )}
          onClick={() => onOpenChange(false)}
        />
      ) : (
        // 无可见蒙层时仍保留"点击空白处关闭"的隐形捕获层 — 命令面板
        // 体验类似 VS Code / Raycast, 但不压暗视口。 pointer-events-auto
        // 配合 transparent bg 让背景点击能命中, 弹窗本身在外层 wrapper
        // 上 pointer-events-none 不受影响。
        <div
          className="fixed inset-0 z-50"
          onClick={() => onOpenChange(false)}
          aria-hidden="true"
        />
      )}
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] pointer-events-none">
        <div
          className={cn(
            'relative w-full max-w-[38rem] mx-4 rounded-xl border border-[var(--border)] bg-[var(--popover)] text-[var(--popover-foreground)] shadow-2xl pointer-events-auto overflow-hidden',
            visible ? 'flowix-dialog-enter' : 'flowix-dialog-leave',
            className,
          )}
        >
          {showCloseButton && (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="absolute top-3 right-3 z-10 p-1 rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div
    className="flex items-center gap-2 border-b border-[var(--border)] px-3"
    cmdk-input-wrapper=""
  >
    <Search className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none',
        'placeholder:text-[var(--muted-foreground)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn(
      'max-h-[420px] overflow-y-auto overflow-x-hidden scroll-py-1 p-1',
      className,
    )}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="py-8 text-center text-sm text-[var(--muted-foreground)]"
    {...props}
  />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-[var(--foreground)]',
      // cmdk 自动给 group heading 套上 [cmdk-group-heading] 选择器,
      // 这里通过相邻选择器统一注入排版样式。
      '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--muted-foreground)]',
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-[var(--border)]', className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-2 text-sm outline-none',
      'text-[var(--foreground)]',
      'data-[selected=true]:bg-[var(--accent)] data-[selected=true]:text-[var(--primary)]',
      'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
      '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-[var(--muted-foreground)]',
      'data-[selected=true]:[&_svg]:text-[var(--primary)]',
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

const CommandShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn(
        'ml-auto text-xs tracking-widest text-[var(--muted-foreground)]',
        className,
      )}
      {...props}
    />
  );
};
CommandShortcut.displayName = 'CommandShortcut';

const CommandLoading = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Loading>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Loading>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Loading
    ref={ref}
    className={cn('py-6 text-center text-sm text-[var(--muted-foreground)]', className)}
    {...props}
  />
));
CommandLoading.displayName = CommandPrimitive.Loading.displayName;

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
  CommandLoading,
};
