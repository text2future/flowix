// 这是 lib/ 下唯一的 .tsx —— 因为模块内要内联一段居中修复用的 JSX 模板。
// 其他 lib 文件保持 .ts。
import type { ComponentType } from 'react';
import { CheckCircleIcon, InfoIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import { toast as sonnerToast } from 'sonner';
import { TOAST_BG, TOAST_COLORS, TOAST_DURATION_MS, TOAST_SHADOW } from './constants';

/** Toast 视觉 tone */
export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface ToastShowOptions {
  /** 视觉 tone,默认 'info' */
  tone?: ToastTone;
  /** 覆盖默认展示时长 (ms) */
  duration?: number;
}

export interface ToastApi {
  success(message: string, options?: Omit<ToastShowOptions, 'tone'>): string | number;
  error(message: string, options?: Omit<ToastShowOptions, 'tone'>): string | number;
  info(message: string, options?: Omit<ToastShowOptions, 'tone'>): string | number;
  warning(message: string, options?: Omit<ToastShowOptions, 'tone'>): string | number;
  show(message: string, options?: ToastShowOptions): string | number;
  dismiss(id?: string | number): void;
}

// 4 种 tone 对应的 phosphor 图标;统一在渲染处注入 weight="fill"
type PhosphorWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

const TONE_ICONS: Record<
  ToastTone,
  ComponentType<
    React.SVGProps<SVGSVGElement> & {
      className?: string;
      style?: React.CSSProperties;
      weight?: PhosphorWeight;
    }
  >
> = {
  success: CheckCircleIcon,
  error: XCircleIcon,
  info: InfoIcon,
  warning: WarningCircleIcon,
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
function ToastPill({ tone, message }: { tone: ToastTone; message: string }) {
  const Icon = TONE_ICONS[tone];
  const color = TOAST_COLORS[tone];
  return (
    <div className="flex w-[var(--width)] justify-center">
      <div
        className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white"
        style={{ backgroundColor: TOAST_BG, boxShadow: TOAST_SHADOW }}
      >
        <Icon className="h-4 w-4" style={{ color }} weight="fill" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function show(message: string, options: ToastShowOptions = {}): string | number {
  const tone = options.tone ?? 'info';
  const duration = options.duration ?? TOAST_DURATION_MS;
  return sonnerToast.custom(() => <ToastPill tone={tone} message={message} />, { duration });
}

export const toast: ToastApi = {
  success: (message, options) => show(message, { ...options, tone: 'success' }),
  error: (message, options) => show(message, { ...options, tone: 'error' }),
  info: (message, options) => show(message, { ...options, tone: 'info' }),
  warning: (message, options) => show(message, { ...options, tone: 'warning' }),
  show,
  dismiss: (id) => sonnerToast.dismiss(id),
};
