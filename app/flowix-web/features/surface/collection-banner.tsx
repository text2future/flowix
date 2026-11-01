'use client';

/**
 * 集合顶部的图片导览 ── 高度 160、宽度 100% 的一条横幅。
 *
 * 图源 = 集合媒体库（按媒体域的 `dataset.source` 取范围，与媒体库面板同一个口径），
 * 或「在线图库」里预置的 Unsplash 直链（`collection-banner-online-images.ts`）。
 * 默认展示色块背景；用户可在悬浮工具条里「切换图片」打开换图弹窗，
 * 三个 tab 切换图源：「内部选择」从笔记本内图片里选一张、「在线图库」选一条
 * 在线链接（统一按 900×200 裁切后写 `banner_image`）、「上传」从本地上传
 * （落盘到笔记本 `attachments/` 后引用其相对路径）。本地相对路径与在线 URL
 * 共用集合属性 `banner_image`（Text），渲染时按 `http(s)://` 前缀区分；也可在
 * 「···」菜单里隐藏头图（属性 `banner_hidden`）。没有可用图片、或在线图加载
 * 失败时（离线 / 链接失效）铺一条同高的浅色纯色占位，色相由集合标题派生且
 * 不落库；头图显隐由外壳的 `banner_hidden` 属性控制。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { dialogs, mediaResources, notebookAssets, type MediaResource } from '@platform/tauri/client';
import {
  CaretDownIcon,
  CheckIcon,
  ImagesIcon,
  SpinnerGapIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import type { CollectionScope } from '@features/collection/public/folder-api';
import { ONLINE_BANNER_IMAGES, onlineBannerBase, onlineBannerCropUrl, onlineBannerThumbUrl } from '@features/collection/public/folder-api';
import { requestMediaPreview } from './media-preview-tasks';
import { bannerHue } from './collection-banner-tint';

/** 一次最多拉取的候选图片数（下拉列表够用，又不至于一次解码太多缩略图）。 */
const BANNER_IMAGE_LIMIT = 60;
/** 上传只收图片：与属性面板的图片取值同一份扩展名清单。 */
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tif|tiff|heic|heif)$/i;
/** 在线图库链接（Unsplash 直链等）：`banner_image` 里以 http(s) 开头即为在线图。 */
const REMOTE_IMAGE_PATTERN = /^https?:\/\//i;

/** 下拉列表项：来自媒体库的资源，或刚上传到 `attachments/` 的图（不在媒体库里）。 */
interface BannerImageOption {
  relativePath: string;
  modifiedMs: number;
}

/**
 * 把本机图片存进笔记本 `attachments/`，返回可直接写进 `banner_image` 的笔记本相对路径。
 * 相对路径是唯一可信的引用形式（集合文件可能被移动/分享），所以这里拒绝任何
 * 落在 attachments/ 之外的落点。
 */
export async function saveBannerImage(
  notebook: { id: string; path: string },
  sourcePath: string,
  t: (key: I18nKey) => string,
): Promise<string | null> {
  try {
    if (!IMAGE_FILE_PATTERN.test(sourcePath)) {
      toast.error(t('collection.banner.imageOnly'));
      return null;
    }
    // 不传 reuseNotebookFile：顶图一律落到 attachments/，避免引用集合范围外的路径。
    const saved = await notebookAssets.saveFromPath(sourcePath, { notebookId: notebook.id });
    if (!saved?.path) throw new Error('Attachment save returned no path');
    const prefix = `${canonicalDirectoryPath(notebook.path)}/`;
    const savedPath = canonicalPath(saved.path);
    if (!savedPath.startsWith(prefix)) throw new Error('Saved banner image is outside the notebook');
    const relative = savedPath.slice(prefix.length);
    if (!relative.startsWith('attachments/')) throw new Error('Saved banner image is outside attachments');
    return relative;
  } catch (error) {
    console.error('[CollectionBanner] Failed to save banner image:', error);
    toast.error(t('collection.banner.uploadFailed'));
    return null;
  }
}

export interface CollectionBannerProps {
  notebookPath: string | null;
  /** 上传落盘要用（`save_notebook_asset` 按笔记本归属找 `attachments/`）。 */
  notebookId: string | null;
  /** 集合标题：没有可用图片时用它派生占位渐变（不落库）。 */
  title: string;
  scope: CollectionScope | undefined;
  /** 是否允许切换图源（集合可编辑时为真）。 */
  editable: boolean;
  /** 用户指定的头图相对路径（集合属性 `banner_image`）；undefined = 用色块背景。 */
  selectedImage: string | undefined;
  /** 选择头图：传相对路径使用指定图，传 null 回退到色块背景。 */
  onSelectImage: (relativePath: string | null) => void;
}

export function CollectionBanner({
  notebookPath,
  notebookId,
  title,
  scope,
  editable,
  selectedImage,
  onSelectImage,
}: CollectionBannerProps) {
  const { t } = useI18n();
  const [images, setImages] = useState<MediaResource[]>([]);
  const [displaySrc, setDisplaySrc] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** 无图占位的色相：只跟标题走，不落库。 */
  const hue = useMemo(() => bannerHue(title), [title]);
  const relativePath = scope?.relativePath ?? null;
  const depth = scope?.depth ?? null;

  // 拉取文件夹内的图片候选（与媒体库面板同一取值范围）。
  useEffect(() => {
    setImages([]);
    if (!notebookPath || relativePath === null || depth === null) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => mediaResources.listPage(notebookPath, ['image'], null, BANNER_IMAGE_LIMIT, relativePath, depth))
      .then((page) => { if (!cancelled) setImages(page.resources); })
      .catch(() => { if (!cancelled) setImages([]); });
    return () => { cancelled = true; };
  }, [depth, notebookPath, relativePath]);

  /**
   * 下拉列表：媒体库图片；若当前头图是上传来的（在 `attachments/`，不进媒体库索引），
   * 把它补到最前面，保证「现在用的是哪张」在列表里始终可见。
   * 在线链接头图不属于本地列表，单独在「在线图库」分组里高亮。
   */
  const options = useMemo<BannerImageOption[]>(() => {
    const list = images.map((item) => ({ relativePath: item.relativePath, modifiedMs: item.modifiedMs }));
    if (selectedImage && !REMOTE_IMAGE_PATTERN.test(selectedImage) && !list.some((item) => item.relativePath === selectedImage)) {
      list.unshift({ relativePath: selectedImage, modifiedMs: 0 });
    }
    return list;
  }, [images, selectedImage]);

  const bannerPath = selectedImage ?? null;

  // 仅解码用户指定的图片；未选择或加载失败时显示色块背景。
  useEffect(() => {
    setDisplaySrc(null);
    if (!selectedImage) return;
    if (REMOTE_IMAGE_PATTERN.test(selectedImage)) {
      setDisplaySrc(selectedImage);
      return;
    }
    if (!notebookPath) return;
    const filePath = joinNotebookMemoPath(notebookPath, selectedImage);
    if (!filePath) return;
    const modifiedMs = images.find((item) => item.relativePath === selectedImage)?.modifiedMs ?? 0;
    const controller = new AbortController();
    const task = requestMediaPreview(filePath, notebookPath, 'image', modifiedMs);
    task.promise
      .then((url) => { if (!controller.signal.aborted) setDisplaySrc(url ?? null); })
      .catch(() => { if (!controller.signal.aborted) setDisplaySrc(null); });
    return () => { controller.abort(); task.cancel(); };
  }, [images, notebookPath, selectedImage]);

  /**
   * 上传图片并直接用作头图：`save_notebook_asset` 默认落在笔记本 `attachments/`
   * （同名同内容会复用已有文件），拿到绝对路径后换算成笔记本相对路径写进
   * `banner_image`，横幅与媒体库都不需要重新扫描。
   */
  const uploadImage = useCallback(async () => {
    if (uploading) return;
    if (!notebookId || !notebookPath) {
      toast.error(t('collection.banner.uploadFailed'));
      return;
    }
    setUploading(true);
    try {
      const [sourcePath] = (await dialogs.selectFiles({ accept: 'image/*', multiple: false })) ?? [];
      if (!sourcePath) return;
      const relative = await saveBannerImage({ id: notebookId, path: notebookPath }, sourcePath, t);
      if (!relative) return;
      onSelectImage(relative);
      setPickerOpen(false);
    } finally {
      setUploading(false);
    }
  }, [notebookId, notebookPath, onSelectImage, t, uploading]);

  return <div className="group relative h-[220px] w-full shrink-0 overflow-hidden">
    {displaySrc
      // 在线链接加载失败（离线 / 链接失效）时置空展示地址，回落纯色占位。
      ? <img src={displaySrc} alt="" aria-hidden="true" className="h-full w-full object-cover" onError={() => setDisplaySrc(null)} />
      // 没有可用图片（含没有媒体域、媒体库为空、读取失败）时铺同高的浅色纯色占位，
      // 不再把顶部空出来 —— 工具条仍可用来选图 / 上传。
      : <div
        className="collection-banner-placeholder h-full w-full"
        aria-hidden="true"
        style={{ '--banner-hue': `${hue}` } as CSSProperties}
      />}
    {editable ? (
      // 下拉窗内容 portal 到 body，指针离开横幅后 :hover / :focus-within 都会丢，
      // 所以展开时用 pickerOpen 兜住工具条，避免「打开下拉窗按钮就跟着消失」。
      <div className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 flex justify-end p-2 transition-opacity',
        'group-hover:pointer-events-auto group-hover:opacity-100',
        'group-focus-within:pointer-events-auto group-focus-within:opacity-100',
        pickerOpen ? 'pointer-events-auto opacity-100' : 'opacity-0',
      )}>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t('collection.banner.switch')}
              title={t('collection.banner.switch')}
              className="inline-flex h-8 items-center gap-1 rounded-xl bg-black/[0.32] px-2.5 text-white backdrop-blur hover:bg-black/50"
            >
              <ImagesIcon size={15} weight="bold" aria-hidden="true" />
              <CaretDownIcon size={10} weight="bold" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="bottom" sideOffset={0} fitViewport className="w-[520px] overflow-x-hidden rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            <BannerImagePicker
              notebookPath={notebookPath}
              options={options}
              selectedPath={bannerPath}
              uploading={uploading}
              onSelect={(nextPath) => { onSelectImage(nextPath); setPickerOpen(false); }}
              onUpload={() => void uploadImage()}
            />
          </PopoverContent>
        </Popover>
      </div>
    ) : null}
  </div>;
}

/** 换图弹窗的三个 tab：笔记本内图片 / 预置在线图库 / 本地上传。 */
type PickerTab = 'folder' | 'online' | 'upload';

interface BannerImagePickerProps {
  notebookPath: string | null;
  options: BannerImageOption[];
  /** 当前生效头图（未指定图时就是列表第一张）。 */
  selectedPath: string | null;
  uploading: boolean;
  onSelect: (relativePath: string) => void;
  onUpload: () => void;
}

function BannerImagePicker({
  notebookPath,
  options,
  selectedPath,
  uploading,
  onSelect,
  onUpload,
}: BannerImagePickerProps) {
  const { t } = useI18n();
  // PopoverContent 关闭即卸载，tab 状态随开随重置到「内部选择」。
  const [tab, setTab] = useState<PickerTab>('folder');
  const tabs: Array<{ key: PickerTab; label: string }> = [
    { key: 'folder', label: t('collection.banner.selectFromFolder') },
    { key: 'online', label: t('collection.banner.onlineGallery') },
    { key: 'upload', label: t('collection.banner.upload') },
  ];
  // 滚动条走产品统一的 OverlayScrollbar：自绘滑块浮在内容之上不占列表宽度，
  // 只在用户滚动时浮现；--edge-aligned 让滑块贴住弹窗右内缘并保留条目留白。
  // 横向滚动条整体禁用（horizontalScrollbar=false + scroller overflow-x-hidden +
  // 弹窗 overflow-x-hidden，抵掉 edge-aligned 负外边距带来的横向溢出）。
  return <div>
    <div role="tablist" className="flex items-center gap-1 px-1 pb-1 pt-0.5">
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => setTab(key)}
          className={cn(
            'h-7 flex-1 rounded-md text-xs transition-colors',
            tab === key
              ? 'bg-[var(--muted)] font-medium text-[var(--foreground)]'
              : 'text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]',
          )}
        >
          {label}
        </button>
      ))}
    </div>
    <OverlayScrollbar
      horizontalScrollbar={false}
      className="overlay-scrollbar-frame--edge-aligned h-[320px] min-h-[320px]"
      scrollerClassName="h-[320px] min-h-[320px] overflow-y-auto overflow-x-hidden"
      observeContent
    >
      {tab === 'folder'
        ? <FolderImageGrid notebookPath={notebookPath} options={options} selectedPath={selectedPath} onSelect={onSelect} />
        : tab === 'online'
          ? <OnlineImageGrid selectedPath={selectedPath} onSelect={onSelect} />
          : <UploadPanel uploading={uploading} onUpload={onUpload} />}
    </OverlayScrollbar>
  </div>;
}

/** 选中项右上角的对勾徽标（内部选择 / 在线图库同一口径）。 */
function SelectedCheck() {
  return <CheckIcon
    size={14}
    weight="bold"
    className="absolute right-1 top-1 rounded-full bg-black/40 p-0.5 text-white"
    aria-hidden="true"
  />;
}

/** 「内部选择」：笔记本内图片，与在线图库同一套双列网格排布（只展示图片）。 */
function FolderImageGrid({
  notebookPath,
  options,
  selectedPath,
  onSelect,
}: {
  notebookPath: string | null;
  options: BannerImageOption[];
  selectedPath: string | null;
  onSelect: (relativePath: string) => void;
}) {
  const { t } = useI18n();
  if (options.length === 0) {
    return <div className="px-2 py-8 text-center text-xs text-[var(--muted-foreground)]">{t('collection.banner.empty')}</div>;
  }
  return <div className="grid grid-cols-2 gap-1 px-1 pb-1">
    {options.map((option) => {
      const selected = option.relativePath === selectedPath;
      return (
        <button
          key={option.relativePath}
          type="button"
          title={option.relativePath.split('/').pop()}
          onClick={() => onSelect(option.relativePath)}
          className={cn(
            'relative overflow-hidden rounded-lg border',
            selected
              ? 'border-[var(--brand)] ring-1 ring-[var(--brand)]'
              : 'border-transparent hover:border-[var(--border)]',
          )}
        >
          <BannerGridThumb notebookPath={notebookPath} resource={option} />
          {selected ? <SelectedCheck /> : null}
        </button>
      );
    })}
  </div>;
}

/** 「在线图库」：预置在线链接（Unsplash 直链），点选后统一按 900×200 裁切
 *  写进 `banner_image`，加载失败时横幅回落标题派生的纯色占位。选中高亮按
 *  去掉查询串的基础地址对回清单项。 */
function OnlineImageGrid({
  selectedPath,
  onSelect,
}: {
  selectedPath: string | null;
  onSelect: (relativePath: string) => void;
}) {
  const { t } = useI18n();
  return <div className="grid grid-cols-2 gap-1 px-1 pb-1">
    {ONLINE_BANNER_IMAGES.map((url) => {
      const selected = selectedPath !== null && onlineBannerBase(selectedPath) === url;
      return (
        <button
          key={url}
          type="button"
          aria-label={t('collection.banner.onlineGallery')}
          onClick={() => onSelect(onlineBannerCropUrl(url))}
          className={cn(
            'relative overflow-hidden rounded-lg border',
            selected
              ? 'border-[var(--brand)] ring-1 ring-[var(--brand)]'
              : 'border-transparent hover:border-[var(--border)]',
          )}
        >
          <img
            src={onlineBannerThumbUrl(url)}
            alt=""
            className="h-9 w-full object-cover object-center"
            loading="lazy"
          />
          {selected ? <SelectedCheck /> : null}
        </button>
      );
    })}
  </div>;
}

/** 「上传」tab：点到本地面板选一张，落盘到 `attachments/` 后立刻用作头图。 */
function UploadPanel({ uploading, onUpload }: { uploading: boolean; onUpload: () => void }) {
  const { t } = useI18n();
  return <div className="p-1 pb-1">
    <button
      type="button"
      disabled={uploading}
      onClick={onUpload}
      className="flex h-16 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border)] text-sm text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {uploading
        ? <SpinnerGapIcon size={16} weight="bold" className="animate-spin" aria-hidden="true" />
        : <UploadSimpleIcon size={16} weight="bold" aria-hidden="true" />}
      <span>{uploading ? t('collection.banner.uploading') : t('collection.banner.upload')}</span>
    </button>
  </div>;
}

function BannerGridThumb({ notebookPath, resource }: { notebookPath: string | null; resource: BannerImageOption }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const filePath = notebookPath ? joinNotebookMemoPath(notebookPath, resource.relativePath) : null;
    if (!filePath) { setSrc(null); return; }
    const controller = new AbortController();
    const task = requestMediaPreview(filePath, notebookPath as string, 'image', resource.modifiedMs);
    task.promise
      .then((url) => { if (!controller.signal.aborted) setSrc(url ?? null); })
      .catch(() => { if (!controller.signal.aborted) setSrc(null); });
    return () => { controller.abort(); task.cancel(); };
  }, [notebookPath, resource.relativePath, resource.modifiedMs]);
  return <span className="block h-9 w-full overflow-hidden bg-[var(--muted)]">
    {src ? <img src={src} alt="" className="h-full w-full object-cover object-center" /> : null}
  </span>;
}
