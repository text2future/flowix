import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import type { MediaResource } from '@platform/tauri/client';
import { joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { Button } from '@shared/ui/button';
import { openMediaTarget } from '@features/workspace/use-cases/workspace-navigation';
import { requestMediaPreview } from '@features/surface/media-preview-tasks';
import imagePlaceholder from '@/assets/placeholder-image-card.jpg';
import videoPlaceholder from '@/assets/placeholder-video-card.jpg';
import { layoutPhotoWall } from './photo-wall-layout';

interface PreparedMedia { resource: MediaResource; preview: string | null; ratio: number }
const preparedCache = new Map<string, { preview: string; ratio: number }>();

function previewRatio(url: string, fallback: number, signal: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    const finish = (ratio: number) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      img.onload = img.onerror = null;
      resolve(ratio);
    };
    const abort = () => { finish(fallback); img.src = ''; };
    const timer = setTimeout(abort, 10000);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : fallback);
    img.onerror = () => finish(fallback);
    img.src = url;
  });
}

function PhotoWallItem({ item, height, notebookId, notebookPath }: { item: PreparedMedia; height: number; notebookId: string; notebookPath: string }) {
  const { resource, preview, ratio } = item;
  const [failed, setFailed] = useState(false);
  const filePath = joinNotebookMemoPath(notebookPath, resource.relativePath);
  const title = resource.relativePath.split(/[\\/]/).pop() ?? resource.relativePath;
  return <button type="button" title={title} aria-label={`打开：${title}`} onClick={() => {
    if (filePath) void openMediaTarget({ filePath, notebookId, notebookPath, resourceKind: resource.kind }).catch((reason) => toast.error(reason instanceof Error ? reason.message : '无法打开媒体资源'));
  }} style={{ flexGrow: ratio, flexBasis: 0, height }} className="group relative min-w-0 overflow-hidden rounded-md bg-[var(--card)] text-left">
    <img src={!failed && preview ? preview : resource.kind === 'video' ? videoPlaceholder : imagePlaceholder} alt="" onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-contain" />
    {resource.kind === 'video' && <span className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white"><Play className="ml-0.5 h-4 w-4 fill-current" /></span></span>}
    <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/45 to-transparent px-2 pb-1.5 pt-5 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">{title}</span>
  </button>;
}

export function MediaLibraryPhotoWall({ resources, notebookId, notebookPath, hasMore, onOpenLibrary }: {
  resources: MediaResource[]; notebookId: string; notebookPath: string; hasMore: boolean; onOpenLibrary: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(0);
  const [width, setWidth] = useState(0);
  const [prepared, setPrepared] = useState<PreparedMedia[] | null>(null);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const resize = () => { widthRef.current = element.clientWidth; setWidth(element.clientWidth); };
    resize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const tasks: ReturnType<typeof requestMediaPreview>[] = [];
    setPrepared(null);
    const prepare = async (resource: MediaResource): Promise<PreparedMedia> => {
      const fallback = resource.kind === 'video' ? 16 / 9 : 1;
      const filePath = joinNotebookMemoPath(notebookPath, resource.relativePath);
      if (!filePath) return { resource, preview: null, ratio: fallback };
      const key = `${notebookPath}\0${resource.relativePath}\0${resource.modifiedMs}\0${resource.kind}`;
      const cached = preparedCache.get(key);
      if (cached) return { resource, ...cached };
      if (controller.signal.aborted) return { resource, preview: null, ratio: fallback };
      const task = requestMediaPreview(filePath, notebookPath, resource.kind, resource.modifiedMs);
      tasks.push(task);
      const preview = await task.promise;
      const ratio = preview ? await previewRatio(preview, fallback, controller.signal) : fallback;
      if (preview && !controller.signal.aborted) {
        preparedCache.set(key, { preview, ratio });
        if (preparedCache.size > 256) preparedCache.delete(preparedCache.keys().next().value!);
      }
      return { resource, preview, ratio };
    };
    void (async () => {
      let items = await Promise.all(resources.slice(0, 30).map(prepare));
      if (controller.signal.aborted) return;
      const layout = layoutPhotoWall(items.map((item) => item.ratio), widthRef.current);
      if (resources.length > 30 && layout.rows.some((row) => row.height < layout.targetHeight * 0.55 || row.height > layout.targetHeight * 1.8)) {
        items = [...items, ...await Promise.all(resources.slice(30, 40).map(prepare))];
      }
      if (!controller.signal.aborted) setPrepared(items);
    })().catch((reason) => {
      if (!controller.signal.aborted) { setPrepared(resources.slice(0, 30).map((resource) => ({ resource, preview: null, ratio: resource.kind === 'video' ? 16 / 9 : 1 }))); toast.error(reason instanceof Error ? reason.message : '无法读取媒体预览'); }
    });
    return () => { controller.abort(); tasks.forEach((task) => task.cancel()); };
  }, [resources, notebookPath]);

  const layout = layoutPhotoWall(prepared?.map((item) => item.ratio) ?? [], width);
  return <div ref={containerRef}>
    {!prepared || !width ? <div className="grid grid-cols-3 gap-0.5" aria-label="正在准备照片墙">{Array.from({ length: 15 }, (_, index) => <div key={index} className="aspect-square animate-pulse rounded-md bg-[var(--muted)]" />)}</div>
      : <div className="flex flex-col gap-0.5">{layout.rows.map((row) => <div key={row.from} className="flex min-w-0 gap-0.5" style={{ height: row.height }}>
        {prepared.slice(row.from, row.to).map((item) => <PhotoWallItem key={`${item.resource.id}:${item.resource.modifiedMs}`} item={item} height={row.height} notebookId={notebookId} notebookPath={notebookPath} />)}
      </div>)}</div>}
    {prepared && width > 0 && (hasMore || layout.count < resources.length) && <div className="mx-auto mt-2 flex w-fit justify-center"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-lg px-3 text-sm text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)] active:bg-transparent" onClick={onOpenLibrary}>查看更多</Button></div>}
  </div>;
}
