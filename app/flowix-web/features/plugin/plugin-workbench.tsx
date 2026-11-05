'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react';
import { joinNotebookMemoPath } from '@/lib/path';
import { useNoteStore } from '@features/memo/store/note-store';
import { notes, type PluginDescriptor } from '@platform/tauri/client';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import type { SurfacePresentationUpdate, SurfaceNotice } from '@features/workspace/public/surface-api';
import { AgentPluginWorkbench } from './plugin-agent-workbench';
import { normalizePluginId } from './plugin-note';

interface PluginWorkbenchProps {
  plugin: PluginDescriptor;
  notebookPath: string | undefined;
  currentNotePath: string | null;
  currentNoteContent: string;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}

export function PluginWorkbench(props: PluginWorkbenchProps) {
  if (props.plugin.manifest.kind !== 'artifact-tool') {
    return <AgentPluginWorkbench {...props} />;
  }
  return <ArtifactToolWorkbench {...props} />;
}

/**
 * Artifact-tool workbench. Generation belongs to the active document Agent;
 * this surface only discovers and opens documents produced by the tool.
 */
function ArtifactToolWorkbench({
  plugin,
  notebookPath,
  reportPresentation,
}: PluginWorkbenchProps) {
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const [documents, setDocuments] = useState<{ relativePath: string; title: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = plugin.manifest.tool?.command
    ?? `flowix plugin create ${plugin.manifest.id} --notebook <name|id|path>`;

  const load = useCallback(async () => {
    if (!selectedNotebook) return;
    setLoading(true);
    setError(null);
    try {
      const indexed = await notes.list(selectedNotebook.id);
      setDocuments(indexed.filter((note) => normalizePluginId(note.properties?.flowix_plugin) === plugin.manifest.id
        && !note.properties?.flowix_artifact)
        .map((note) => ({ relativePath: note.relativePath, title: note.title })));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [plugin.manifest.id, selectedNotebook]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const notices: SurfaceNotice[] = error ? [{
      id: 'artifact-list', severity: 'error',
      message: { key: 'error.unexpected', fallbackText: error },
      actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: load }],
    }] : [];
    reportPresentation?.({ state: { status: 'ready', notices } });
  }, [error, load, reportPresentation]);

  if (!notebookPath || !selectedNotebook) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">请先选择一个笔记本</div>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--document-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--divider)] px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-lg bg-[var(--muted)] p-2 text-[var(--foreground)]">
            <TreeStructureIcon size={18} weight="bold" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-[var(--foreground)]">{plugin.manifest.name}</h1>
            <p className="text-xs text-[var(--muted-foreground)]">由文档内 Agent 调用工具创建</p>
          </div>
        </div>
        <button
          className="rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
          onClick={() => { void load(); }}
          disabled={loading}
          title="刷新"
          aria-label={`刷新${plugin.manifest.name}列表`}
        >
          <ArrowClockwiseIcon size={16} weight="bold" className={loading ? 'flowix-spin' : undefined} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="rounded-xl border border-[var(--divider)] bg-[var(--card)] p-4">
            <div className="flex items-start gap-3">
              <TerminalWindowIcon size={18} weight="bold" className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--foreground)]">在 Agent 会话中创建{plugin.manifest.name}</p>
                <p className="mt-1 text-sm leading-6 text-[var(--muted-foreground)]">
                  直接告诉文档内 Agent 创建{plugin.manifest.name}。Agent 会按照插件说明调用工具，完成后文档会出现在下方列表。
                </p>
                <code className="mt-3 block overflow-x-auto rounded-lg bg-[var(--muted)] px-3 py-2 text-xs text-[var(--foreground)]">
                  {command}
                </code>
              </div>
            </div>
          </div>

          {error && !reportPresentation && <p className="rounded-lg bg-[color-mix(in_oklch,var(--destructive)_10%,transparent)] p-3 text-sm text-[var(--destructive)]">{error}</p>}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">已生成文档</h2>
              <span className="text-xs text-[var(--muted-foreground)]">{documents.length}</span>
            </div>
            <div className="overflow-hidden rounded-xl border border-[var(--divider)] bg-[var(--card)]">
              {documents.map((note) => (
                <button key={note.relativePath}
                  className="flex w-full items-center gap-3 border-b border-[var(--divider)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--muted)]"
                  onClick={() => {
                    const path = joinNotebookMemoPath(selectedNotebook.path, note.relativePath);
                    if (path) void openWorkspaceSurface({
                      index: 1,
                      target: { kind: 'external', path, scopePath: null, transitionId: null },
                    });
                  }}>
                  <TreeStructureIcon size={16} weight="bold" className="shrink-0 text-[var(--muted-foreground)]" />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--foreground)]">{note.title}</span>
                  <ArrowSquareOutIcon size={15} className="shrink-0 text-[var(--muted-foreground)]" />
                </button>
              ))}
              {!loading && documents.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">当前笔记本还没有{plugin.manifest.name}</p>
              )}
              {loading && documents.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">正在加载…</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
