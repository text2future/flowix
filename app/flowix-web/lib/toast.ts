import { useSyncExternalStore } from 'react';
import { TOAST_DURATION_MS } from '@/lib/constants';

/** Toast 视觉 tone */
export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface ToastShowOptions {
  /** 视觉 tone,默认 'info' */
  tone?: ToastTone;
  /** 覆盖默认展示时长 (ms) */
  duration?: number;
  /** 第二行补充说明 (例如错误详情) */
  description?: string;
}

export interface ToastApi {
  success(message: string, options?: Omit<ToastShowOptions, 'tone'>): string | number;
  error(message: string, options?: Omit<ToastShowOptions, 'tone'>): string | number;
  info(message: string, options?: Omit<ToastShowOptions, 'tone'>): string | number;
  warning(message: string, options?: Omit<ToastShowOptions, 'tone'>): string | number;
  show(message: string, options?: ToastShowOptions): string | number;
  dismiss(id?: string | number): void;
}

/** 交给渲染器的一条展示请求。`id` 是门面自己发的本地 id。 */
export interface ToastRenderRequest {
  id: number;
  tone: ToastTone;
  message: string;
  duration: number;
  description?: string;
}

export interface ToastRenderer {
  render(request: ToastRenderRequest): string | number;
  dismiss(id?: string | number): void;
}

// sonner 是启动图里最不该出现的依赖之一: 一个 toast 库占 ~34KB, 但首屏几乎
// 不会弹提示。所以门面本身不 import 它 —— 只有真的有人要弹提示时才
// ensureToastHost() 触发 <ToastHost/> 的动态挂载, 由它反过来 attachToastRenderer。
//
// 队列负责这段空窗: 挂载前发出的提示先按本地 id 排队, 渲染器就绪后按序回放,
// 并把本地 id 映射到渲染器返回的 id, 这样调用方的 dismiss(localId) 依然有效。
let nextId = 1;
let renderer: ToastRenderer | null = null;
let hostRequested = false;
const queued: ToastRenderRequest[] = [];
const renderedIds = new Map<number, string | number>();
const listeners = new Set<() => void>();

// 挂载前的积压有上限: 宿主始终没能挂载时(极端情况)不该无限攒请求, 而且一次性
// 回放十几条也只会互相盖住。超限丢最旧的。
const MAX_QUEUED_TOASTS = 8;
// 本地 id → 渲染器 id 只服务于 dismiss, 召回窗口很短; 上限防止长会话里单调增长。
const MAX_TRACKED_IDS = 50;

function rememberRendered(localId: number, renderedId: string | number): void {
  renderedIds.set(localId, renderedId);
  while (renderedIds.size > MAX_TRACKED_IDS) {
    const oldest = renderedIds.keys().next();
    if (oldest.done) break;
    renderedIds.delete(oldest.value);
  }
}

function emitHostRequested(): void {
  for (const listener of listeners) listener();
}

/** 请求挂载渲染宿主 (幂等)。 */
export function ensureToastHost(): void {
  if (hostRequested) return;
  hostRequested = true;
  emitHostRequested();
}

export function subscribeToastHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isToastHostRequested(): boolean {
  return hostRequested;
}

/** 宿主是否已被请求挂载; 供 <AppToaster/> 决定要不要渲染动态宿主。 */
export function useToastHostRequested(): boolean {
  return useSyncExternalStore(subscribeToastHost, isToastHostRequested, isToastHostRequested);
}

/** 渲染器挂载/卸载时调用; 未回放的队列在这里补渲染。 */
export function attachToastRenderer(next: ToastRenderer | null): () => void {
  renderer = next;
  if (next) {
    for (const request of queued.splice(0)) {
      rememberRendered(request.id, next.render(request));
    }
  }
  return () => {
    if (renderer === next) renderer = null;
  };
}

function show(message: string, options: ToastShowOptions = {}): string | number {
  const request: ToastRenderRequest = {
    id: nextId,
    tone: options.tone ?? 'info',
    message,
    duration: options.duration ?? TOAST_DURATION_MS,
    description: options.description,
  };
  nextId += 1;
  if (renderer) {
    rememberRendered(request.id, renderer.render(request));
  } else {
    queued.push(request);
    if (queued.length > MAX_QUEUED_TOASTS) queued.shift();
    ensureToastHost();
  }
  return request.id;
}

function dismiss(id?: string | number): void {
  if (id === undefined) {
    queued.length = 0;
    renderedIds.clear();
    renderer?.dismiss();
    return;
  }
  if (typeof id === 'number') {
    const pendingIndex = queued.findIndex((request) => request.id === id);
    if (pendingIndex >= 0) {
      queued.splice(pendingIndex, 1);
      return;
    }
    const rendered = renderedIds.get(id);
    if (rendered !== undefined) {
      renderedIds.delete(id);
      renderer?.dismiss(rendered);
      return;
    }
  }
  renderer?.dismiss(id);
}

export const toast: ToastApi = {
  success: (message, options) => show(message, { ...options, tone: 'success' }),
  error: (message, options) => show(message, { ...options, tone: 'error' }),
  info: (message, options) => show(message, { ...options, tone: 'info' }),
  warning: (message, options) => show(message, { ...options, tone: 'warning' }),
  show,
  dismiss,
};
