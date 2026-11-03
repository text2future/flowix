'use client';

import { useEffect, type ComponentType, type CSSProperties, type SVGProps } from 'react';
import { Toaster, toast as sonnerToast } from 'sonner';
import 'sonner/dist/styles.css';
import { CheckCircleIcon, InfoIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import { attachToastRenderer, type ToastTone } from '@/lib/toast';
import { TOAST_SHADOW } from '@/lib/constants';

// 这个模块是启动图之外的一块: 只在真的需要弹提示时才被 lib/toast 动态挂载,
// 所以 sonner (~34KB) 与 4 个 phosphor 图标都不进首屏。改动这里不会影响门面语义。

type PhosphorWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

type PhosphorIcon = ComponentType<
  SVGProps<SVGSVGElement> & {
    className?: string;
    style?: CSSProperties;
    weight?: PhosphorWeight;
  }
>;

const TONE_ICONS: Record<ToastTone, PhosphorIcon> = {
  success: CheckCircleIcon,
  error: XCircleIcon,
  info: InfoIcon,
  warning: WarningCircleIcon,
};

const TONE_COLORS: Record<ToastTone, string> = {
  success: 'var(--success)',
  error: 'var(--destructive)',
  info: 'var(--info)',
  warning: 'var(--warning)',
};

/**
 * 实际渲染的胶囊提示框。
 *
 * 关键点:外层 `<div className="flex w-[var(--width)] justify-center">` 把 sonner
 * 渲染出来的 `<li data-sonner-toast>` 撑到 356px (toaster 设置的 `--width` 变量
 * 会继承),再用 `justify-center` 把真正的提示框居中。这是为了修复:
 * `toast.custom()` 路径下 sonner 不会给 li 应用 `width: 356px; display: flex`,
 * 导致内容紧贴 356px toaster 的左边缘、相对窗口偏左的 bug。
 */
function ToastPill({ tone, message, description }: { tone: ToastTone; message: string; description?: string }) {
  const Icon = TONE_ICONS[tone];
  const color = TONE_COLORS[tone];
  return (
    <div className="flex w-[var(--width)] justify-center">
      <div
        className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium"
        style={{
          backgroundColor: 'var(--floating-bg)',
          color: 'var(--floating-foreground)',
          boxShadow: TOAST_SHADOW,
        }}
      >
        <Icon className="h-4 w-4" style={{ color }} weight="fill" />
        <span className="min-w-0">
          <span className="block">{message}</span>
          {description ? (
            <span className="block text-xs font-normal opacity-70">{description}</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/**
 * 提示渲染宿主: 挂载 sonner 的 `<Toaster/>`, 并把渲染能力回注册给 lib/toast。
 * 只在有提示要弹时被动态加载, 队列里积压的请求由 attachToastRenderer 回放。
 */
export function ToastHost({ className = 'flowix-toaster' }: { className?: string }) {
  useEffect(() => attachToastRenderer({
    render: (request) => sonnerToast.custom(
      () => <ToastPill tone={request.tone} message={request.message} description={request.description} />,
      { duration: request.duration },
    ),
    dismiss: (id) => sonnerToast.dismiss(id),
  }), []);

  return (
    <Toaster
      className={className}
      position="top-center"
      richColors={false}
      closeButton={false}
    />
  );
}
