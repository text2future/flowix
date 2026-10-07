import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { files, externalDocuments } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { Input } from '@shared/ui/input';
import { parseMediaLibrary } from './model';

interface InsertRange { from: number; to: number }
interface MediaLibraryCandidate {
  notebookId: string;
  notebookName: string;
  notebookPath: string;
  relativePath: string;
  collectionId: string;
  name: string;
}
export type MediaLibraryReferencePickerAnchor =
  | { kind: 'slash'; rect: Pick<DOMRect, 'left' | 'top' | 'bottom'> }
  | { kind: 'button'; element: HTMLElement };

let pickerRoot: Root | null = null;
let pickerHost: HTMLDivElement | null = null;
let pickerGeneration = 0;
const PICKER_WIDTH = 272;

function closePicker(generation?: number) {
  if (generation !== undefined && generation !== pickerGeneration) return;
  pickerGeneration += 1;
  const root = pickerRoot;
  const host = pickerHost;
  pickerRoot = null;
  pickerHost = null;
  root?.unmount();
  host?.remove();
}

function updatePickerPosition(editor: Editor, position: number, anchor: MediaLibraryReferencePickerAnchor) {
  if (!pickerHost || editor.isDestroyed) return;
  try {
    const coords = editor.view.coordsAtPos(position);
    const rect = anchor.kind === 'button' && anchor.element.isConnected
      ? anchor.element.getBoundingClientRect()
      : anchor.kind === 'slash' ? anchor.rect : coords;
    const width = Math.min(PICKER_WIDTH, window.innerWidth - 16);
    const height = Math.min(pickerHost.offsetHeight || 320, window.innerHeight - 16);
    const top = Math.min(Math.max(anchor.kind === 'button' ? rect.bottom : rect.top, 8), Math.max(8, window.innerHeight - height - 8));
    const left = Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - width - 8));
    pickerHost.style.width = `${width}px`;
    pickerHost.style.maxHeight = `${Math.max(160, window.innerHeight - 16)}px`;
    pickerHost.style.top = `${top}px`;
    pickerHost.style.left = `${left}px`;
  } catch { closePicker(); }
}

function MediaLibraryReferencePicker({ editor, replaceRange, anchor, generation, onClose }: {
  editor: Editor;
  replaceRange: InsertRange;
  anchor: MediaLibraryReferencePickerAnchor;
  generation: number;
  onClose: () => void;
}) {
  const notebookItems = useNoteStore((state) => state.notebooks);
  const notebooks = useMemo(() => notebookItems.filter((notebook) => !notebook.missing), [notebookItems]);
  const [candidates, setCandidates] = useState<MediaLibraryCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const current = () => pickerGeneration === generation && pickerRoot !== null;

  useEffect(() => {
    searchRef.current?.focus();
    const outside = (event: MouseEvent) => { if (event.target instanceof Node && !pickerHost?.contains(event.target)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    const reposition = () => updatePickerPosition(editor, replaceRange.from, anchor);
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchor, editor, onClose, replaceRange.from]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void Promise.all(notebooks.map(async (notebook) => {
      try {
        return { notebook, libraries: await files.listMediaLibraries(notebook.id), error: null as string | null };
      } catch (error) {
        return { notebook, libraries: [], error: error instanceof Error ? error.message : String(error) };
      }
    })).then((results) => {
      if (!active) return;
      const available = results.flatMap(({ notebook, libraries }) => libraries.map((library) => ({
        notebookId: notebook.id,
        notebookName: notebook.name,
        notebookPath: notebook.path,
        relativePath: library.relativePath,
        collectionId: library.collectionId,
        name: library.name,
      })));
      available.sort((left, right) => `${left.notebookName}/${left.relativePath}`.localeCompare(`${right.notebookName}/${right.relativePath}`));
      setCandidates(available);
      const failure = results.find((result) => result.error);
      if (available.length === 0 && failure?.error) setLoadError(`无法读取媒体库列表（${failure.notebook.name}：${failure.error}）`);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notebooks]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? candidates.filter((item) => `${item.name} ${item.notebookName} ${item.relativePath}`.toLocaleLowerCase().includes(normalized)) : candidates;
  }, [candidates, query]);
  useLayoutEffect(() => { updatePickerPosition(editor, replaceRange.from, anchor); }, [anchor, editor, filtered.length, loading, replaceRange.from]);

  const select = async (candidate: MediaLibraryCandidate) => {
    if (openingPath || !current()) return;
    setOpeningPath(candidate.relativePath);
    try {
      const filePath = joinNotebookMemoPath(candidate.notebookPath, candidate.relativePath);
      if (!filePath) throw new Error('媒体库路径无效');
      const source = await externalDocuments.read(filePath, candidate.notebookPath);
      if (!current()) return;
      const document = parseMediaLibrary(source);
      if (document.collection.id !== candidate.collectionId) throw new Error('媒体库文件已更新，请重新选择');
      if (editor.isDestroyed || !editor.isEditable) {
        closePicker(generation);
        if (!editor.isDestroyed) toast.error('当前笔记为只读，无法插入媒体库引用');
        return;
      }
      const inserted = editor.chain().focus().insertContentAt(replaceRange, {
        type: 'mediaLibraryReference',
        attrs: { notebookId: candidate.notebookId, relativePath: candidate.relativePath, collectionId: candidate.collectionId },
      }).run();
      if (!inserted) throw new Error('无法在当前位置插入媒体库引用');
      closePicker(generation);
    } catch (error) {
      if (!current()) return;
      toast.error(error instanceof Error ? error.message : '读取媒体库失败');
      setOpeningPath(null);
    }
  };

  return <div className="slash-menu-dropdown table-reference-picker" role="dialog" aria-label="选择媒体库">
    <label className="table-reference-picker__search">
      <Input ref={searchRef} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索媒体库" className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0" />
    </label>
    <div className="slash-menu-items-frame">
      <div className="slash-menu-items" role="listbox" aria-label="媒体库列表">
        {loading ? <div className="slash-menu-empty">正在读取媒体库…</div>
          : loadError ? <div className="slash-menu-empty text-[var(--destructive)]">{loadError}</div>
            : filtered.length === 0 ? <div className="slash-menu-empty">{candidates.length ? '没有匹配的媒体库' : '当前没有媒体库'}</div>
              : filtered.map((candidate) => <button key={`${candidate.notebookId}:${candidate.relativePath}`} type="button" role="option" aria-selected="false" disabled={openingPath !== null} onMouseDown={(event) => event.preventDefault()} onClick={() => void select(candidate)} className="slash-menu-item disabled:opacity-50">
                <span className="slash-menu-item-label min-w-0 flex-1">
                  <span className="block truncate">{candidate.name}</span>
                  <span className="block truncate text-xs text-[var(--muted-foreground)]">{candidate.notebookName} / {candidate.relativePath}</span>
                </span>
                {openingPath === candidate.relativePath && <span className="text-xs text-[var(--muted-foreground)]">读取中</span>}
              </button>)}
      </div>
    </div>
  </div>;
}

export function openMediaLibraryReferencePicker(editor: Editor, replaceRange: InsertRange, anchor: MediaLibraryReferencePickerAnchor) {
  closePicker();
  const generation = pickerGeneration;
  pickerHost = document.createElement('div');
  pickerHost.dataset.mediaLibraryReferencePicker = 'true';
  pickerHost.style.position = 'fixed';
  pickerHost.style.zIndex = '2147483647';
  pickerHost.style.width = `${PICKER_WIDTH}px`;
  document.body.appendChild(pickerHost);
  pickerRoot = createRoot(pickerHost);
  pickerRoot.render(<MediaLibraryReferencePicker editor={editor} replaceRange={replaceRange} anchor={anchor} generation={generation} onClose={() => closePicker(generation)} />);
  requestAnimationFrame(() => updatePickerPosition(editor, replaceRange.from, anchor));
}
