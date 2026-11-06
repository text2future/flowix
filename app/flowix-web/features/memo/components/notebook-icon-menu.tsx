'use client';

import { DialogFooter } from '@shared/ui/dialog-footer';
import { Button } from '@shared/ui/button';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { PREFERENCE_TAB_GROUPS } from '@features/preferences/public/tabs-api';
import { AgentIcon } from '@features/agent/public/icon-api';
import productLogo from '@/assets/productlogo.png';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { openUrl } from '@platform/tauri/opener';
import { Check, ChevronDown, Plus, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { cloud, type CloudFeedbackAttachment } from '@platform/tauri/client/cloud';
import { product } from '@platform/tauri/client/desktop';

interface NotebookIconMenuProps {
  /** 打开偏好设置窗口; 可传入偏好 tab id (如 'theme' / 'dsh' / 'mcp' / 'aiAgent')。 */
  onOpenPreferences: (tab?: string) => void;
  buttonClassName?: string;
  productIconClassName?: string;
}

// hover 打开下拉窗的延迟: 指针悬停多久后展示菜单。
const HOVER_OPEN_DELAY_MS = 800;
// hover 打开下拉窗的关闭延迟: 给指针留出从图标(trigger)跨越到 portal 菜单的间隙。
const HOVER_CLOSE_DELAY_MS = 150;
const NOTEBOOK_ICON_MENU_CLASS =
  'w-[12.8rem] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const NOTEBOOK_ICON_MENU_ITEM_CLASS =
  'group h-7 items-center justify-start gap-1.5 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]';
const OFFICIAL_SITE_URL = 'https://flowix.cc';
const COMMUNITY_URL = 'https://github.com/text2future/flowix';

/**
 * 中间列顶部的图标 (统一展示产品图标):
 * - hover 图标 → 延迟展示 Flowix 下拉菜单 (笔记导航 / 偏好设置)
 * - 点击整个产品图标按钮 → 展示下拉菜单
 */
export function NotebookIconMenu({
  onOpenPreferences,
  buttonClassName,
  productIconClassName,
}: NotebookIconMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState<'product_suggestion' | 'usage_issue'>('product_suggestion');
  const [feedbackTypeTriggerWidth, setFeedbackTypeTriggerWidth] = useState<number | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackFiles, setFeedbackFiles] = useState<File[]>([]);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const feedbackBusyRef = useRef(false);
  const [feedbackPreviews, setFeedbackPreviews] = useState<Array<{ file: File; url: string }>>([]);
  const feedbackFileInputRef = useRef<HTMLInputElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const visiblePreferenceGroups = PREFERENCE_TAB_GROUPS.map((group) => ({
    ...group,
    tabs: group.tabs.filter((tab) => !('visibleInProductMenu' in tab) || tab.visibleInProductMenu !== false),
  }));

  const openFeedback = () => {
    setOpen(false);
    setFeedbackOpen(true);
  };

  const addFeedbackFiles = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    const next = [...feedbackFiles, ...incoming];
    if (next.length > 3 || next.some((file) => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024)) {
      toast.error(t('memo.list.notebookMenu.feedback.imageLimit'));
      return;
    }
    setFeedbackFiles(next);
  }, [feedbackFiles, t]);

  useEffect(() => {
    const previews = feedbackFiles.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setFeedbackPreviews(previews);
    return () => previews.forEach(({ url }) => URL.revokeObjectURL(url));
  }, [feedbackFiles]);

  useEffect(() => {
    if (!feedbackOpen) return;
    const handlePaste = (event: ClipboardEvent) => {
      if (feedbackBusyRef.current) {
        event.preventDefault();
        return;
      }
      const clipboardItems = Array.from(event.clipboardData?.items ?? []);
      const images = clipboardItems
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (images.length === 0) return;
      event.preventDefault();
      addFeedbackFiles(images);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [feedbackOpen, addFeedbackFiles]);

  const getFeedbackDeviceId = () => {
    const storageKey = 'flowix:feedback-device-id:v1';
    try {
      const existing = localStorage.getItem(storageKey);
      if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(existing)) return existing;
      const deviceId = crypto.randomUUID();
      localStorage.setItem(storageKey, deviceId);
      return deviceId;
    } catch {
      return crypto.randomUUID();
    }
  };

  const readFeedbackImages = async (): Promise<CloudFeedbackAttachment[]> => Promise.all(feedbackFiles.map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { filename: file.name, contentType: file.type, dataBase64: btoa(binary) };
  }));

  const submitFeedback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (feedbackBusyRef.current || !feedbackText.trim()) return;
    feedbackBusyRef.current = true;
    setFeedbackBusy(true);
    try {
      const productInfo = await product.getInfo();
      const architecture = productInfo.arch === 'aarch64' ? 'arm64' : productInfo.arch === 'x86_64' ? 'x64' : productInfo.arch;
      const platform = `${productInfo.os}-${architecture}`;
      await cloud.submitFeedback(
        getFeedbackDeviceId(),
        feedbackType,
        feedbackText.trim(),
        productInfo.version,
        platform,
        await readFeedbackImages(),
      );
      toast.success(t('memo.list.notebookMenu.feedback.submitSucceeded'));
      setFeedbackOpen(false);
      setFeedbackText('');
      setFeedbackFiles([]);
    } catch {
      toast.error(t('memo.list.notebookMenu.feedback.submitFailed'));
    } finally {
      feedbackBusyRef.current = false;
      setFeedbackBusy(false);
    }
  };

  const cancelOpen = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // 悬停后延迟展示菜单; 离开图标或点击图标都会取消未触发的打开。
  const scheduleOpen = useCallback(() => {
    cancelOpen();
    cancelClose();
    openTimerRef.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  }, [cancelOpen, cancelClose]);

  // 离开图标/菜单后延迟收起, 给指针留出跨越间隙的时间; 同时取消未触发的打开。
  const scheduleClose = useCallback(() => {
    cancelOpen();
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  }, [cancelOpen, cancelClose]);

  useEffect(() => {
    return () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild onClick={() => setOpen(true)}>
        <button
          type="button"
          aria-label={t('memo.list.notebookMenu.open')}
          title={t('memo.list.notebookMenu.open')}
          className={cn('group relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center', buttonClassName)}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
        >
          <img
            src={productLogo}
            alt=""
            aria-hidden="true"
            className={cn(
              'product-icon h-[18px] w-[18px] shrink-0 rounded opacity-30 transition-opacity group-hover:opacity-100',
              productIconClassName,
            )}
          />
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute bottom-[3px] right-[3px] h-0 w-0 border-b-[5px] border-l-[5px] border-l-transparent transition-opacity',
              open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
            style={{
              borderBottomColor: 'color-mix(in oklch, var(--foreground) 30%, var(--bg-titlebar))',
            }}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={2}
        className={NOTEBOOK_ICON_MENU_CLASS}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        {visiblePreferenceGroups.map((group) => (
          <div key={group.labelKey}>
            <DropdownMenuLabel className="shrink-0 px-2 py-1 text-xs font-normal uppercase tracking-wider text-[var(--muted-foreground)]">
              {t(group.labelKey)}
            </DropdownMenuLabel>
            {group.tabs.map((tab) => (
              <DropdownMenuItem
                key={tab.id}
                onClick={() => onOpenPreferences(tab.id)}
                className={NOTEBOOK_ICON_MENU_ITEM_CLASS}
              >
                {tab.id === 'pi' ? (
                  <AgentIcon typeKey="pi" alt="" className="h-4 w-4 shrink-0 object-contain" />
                ) : (
                  tab.icon
                )}
                <span>{t(tab.labelKey)}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <DropdownMenuLabel className="shrink-0 px-2 py-1 text-xs font-normal uppercase tracking-wider text-[var(--muted-foreground)]">
          {t('memo.list.notebookMenu.about')}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => void openUrl(OFFICIAL_SITE_URL)}
          className={NOTEBOOK_ICON_MENU_ITEM_CLASS}
        >
          <span>{t('memo.list.notebookMenu.officialWebsite')}</span>
          <span className="ml-auto font-mono text-xs text-[var(--muted-foreground)]">Flowix.CC</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void openUrl(COMMUNITY_URL)}
          className={NOTEBOOK_ICON_MENU_ITEM_CLASS}
        >
          <span>{t('memo.list.notebookMenu.community')}</span>
          <span className="ml-auto font-mono text-xs text-[var(--muted-foreground)]">GitHub</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={openFeedback} className={NOTEBOOK_ICON_MENU_ITEM_CLASS}>
          <span>{t('memo.list.notebookMenu.feedback')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
      <Dialog open={feedbackOpen} onOpenChange={(next) => { if (!feedbackBusy) setFeedbackOpen(next); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('memo.list.notebookMenu.feedback.title')}</DialogTitle>
            <DialogDescription>{t('memo.list.notebookMenu.feedback.description')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submitFeedback(event)}>
            <div className="space-y-4">
              <div className="space-y-1.5 text-sm">
                <span className="block">{t('memo.list.notebookMenu.feedback.type')}<span className="ml-1 rounded-md bg-[color-mix(in_oklch,var(--success)_15%,transparent)] px-1.5 py-0.5 text-xs text-[var(--success)]">{t('memo.list.notebookMenu.feedback.required')}</span></span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild onClick={(event) => setFeedbackTypeTriggerWidth(event.currentTarget.getBoundingClientRect().width)}>
                    <button type="button" aria-required="true" disabled={feedbackBusy} className="flex h-9 w-1/2 items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                      <span>{t(`memo.list.notebookMenu.feedback.${feedbackType === 'product_suggestion' ? 'suggestion' : 'issue'}`)}</span>
                      <ChevronDown className="h-4 w-4 text-[var(--muted-foreground)]" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" sideOffset={4} style={{ width: feedbackTypeTriggerWidth ?? undefined }} className="min-w-0 space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                    <DropdownMenuItem onClick={() => setFeedbackType('product_suggestion')} className="flex h-8 items-center justify-between rounded-lg px-2 hover:bg-[var(--hover-bg)]">
                      <span>{t('memo.list.notebookMenu.feedback.suggestion')}</span>
                      {feedbackType === 'product_suggestion' && <Check className="h-4 w-4 text-[var(--brand)]" />}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setFeedbackType('usage_issue')} className="flex h-8 items-center justify-between rounded-lg px-2 hover:bg-[var(--hover-bg)]">
                      <span>{t('memo.list.notebookMenu.feedback.issue')}</span>
                      {feedbackType === 'usage_issue' && <Check className="h-4 w-4 text-[var(--brand)]" />}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <label className="block space-y-1.5 text-sm">
                <span>{t('memo.list.notebookMenu.feedback.content')}<span className="ml-1 rounded-md bg-[color-mix(in_oklch,var(--success)_15%,transparent)] px-1.5 py-0.5 text-xs text-[var(--success)]">{t('memo.list.notebookMenu.feedback.required')}</span></span>
                <textarea required maxLength={2000} disabled={feedbackBusy} value={feedbackText} onChange={(event) => setFeedbackText(event.target.value)} rows={6} className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)] disabled:opacity-50" placeholder={t('memo.list.notebookMenu.feedback.placeholder')} />
              </label>
              <div className="block space-y-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <span>{t('memo.list.notebookMenu.feedback.attachments')}</span>
                  <span className="text-sm text-[var(--muted-foreground)]">{t('memo.list.notebookMenu.feedback.imageHint')}</span>
                </div>
                <input ref={feedbackFileInputRef} type="file" disabled={feedbackBusy} aria-label={t('memo.list.notebookMenu.feedback.attachments')} accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  addFeedbackFiles(files);
                  event.target.value = '';
                }} />
                <div className="flex flex-wrap gap-2 pt-1">
                  {feedbackPreviews.map(({ file, url }, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="relative h-[100px] w-[100px] shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
                    <img src={url} alt={file.name} className="h-full w-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-1 text-[10px] text-white" title={file.name}>{file.name}</span>
                    <button type="button" disabled={feedbackBusy} onClick={() => setFeedbackFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} aria-label={t('memo.list.notebookMenu.feedback.removeImage')} title={t('memo.list.notebookMenu.feedback.removeImage')} className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>)}
                  {feedbackFiles.length < 3 && <button type="button" disabled={feedbackBusy} onClick={() => feedbackFileInputRef.current?.click()} aria-label={t('memo.list.notebookMenu.feedback.addImage')} title={t('memo.list.notebookMenu.feedback.addImage')} className="flex h-[100px] w-[100px] shrink-0 items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition-colors hover:border-[var(--brand)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] disabled:opacity-50">
                    <Plus className="h-7 w-7" />
                  </button>}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" disabled={feedbackBusy} onClick={() => setFeedbackOpen(false)} variant="outline">{t('memo.list.notebookMenu.feedback.cancel')}</Button>
              <Button type="submit" disabled={feedbackBusy || !feedbackText.trim()} variant="default">{feedbackBusy ? t('memo.list.notebookMenu.feedback.submitting') : t('memo.list.notebookMenu.feedback.submit')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </DropdownMenu>
  );
}
