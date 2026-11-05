'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowSquareOutIcon,
  CornersInIcon,
  CornersOutIcon,
  MagicWandIcon,
  SidebarSimpleIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import { AGENT_TYPES, isAgentTypeSelectable } from '@/lib/agent-types';
import { canonicalPath } from '@/lib/path';
import type { AgentTypeKey } from '@/types/agent';
import { useNoteStore } from '@features/memo/store/note-store';
import { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
import {
  type PluginDescriptor,
  type PluginField,
} from '@platform/tauri/client';
import type { SurfaceNotice, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { runPlugin } from './plugin-runner';
import {
  ensurePluginRunStoreSubscription,
  pluginRunContextKey,
  usePluginRunStore,
} from './plugin-run-store';
import {
  PluginArtifactRenderer,
  type PluginArtifactRendererHandle,
} from './plugin-artifact-renderer';
import {
  isEmptyPluginFieldValue,
  pluginFieldLabel,
  PluginFieldControl,
  type PluginFieldValue,
} from './plugin-field-control';
import { DEFAULT_AGENT_TYPE_KEY } from '@/lib/agent-types';
import { PluginMarkmapControls } from './plugin-markmap-controls';

function fieldList(plugin: PluginDescriptor): PluginField[] {
  const fields = plugin.manifest.input?.fields ?? [];
  return fields.length > 0 ? fields : [
    ...(plugin.manifest.input.prompt ? [{ ...plugin.manifest.input.prompt, id: 'prompt' }] : []),
    ...(plugin.manifest.input.agentType ? [{ ...plugin.manifest.input.agentType, id: 'agentType' }] : []),
  ];
}

export function AgentPluginWorkbench({
  plugin,
  notebookPath,
  currentNotePath,
  currentNoteContent,
  reportPresentation,
}: {
  plugin: PluginDescriptor;
  notebookPath: string | undefined;
  currentNotePath: string | null;
  currentNoteContent: string;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}) {
  const [values, setValues] = useState<Record<string, PluginFieldValue>>({ prompt: '' });
  const [agentType, setAgentType] = useState<AgentTypeKey>(DEFAULT_AGENT_TYPE_KEY);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PluginArtifactRendererHandle>(null);
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const runNotebookPath = notebookPath ?? selectedNotebook?.path ?? null;
  const latestRunId = usePluginRunStore((state) => (
    runNotebookPath
      ? state.latestRunIdByContext[pluginRunContextKey(plugin.manifest.id, runNotebookPath)]
      : undefined
  ));
  const run = usePluginRunStore((state) => latestRunId ? state.runs[latestRunId] ?? null : null);
  const artifact = run?.artifact ?? null;
  const running = run?.status === 'queued' || run?.status === 'running';
  const error = requestError ?? run?.error ?? null;
  const runStatus = run?.status ?? null;
  const hasCanvasControls = artifact?.renderer === 'markmap';
  const agentOptions = useMemo(
    () => AGENT_TYPES.filter((item) => isAgentTypeSelectable(item.id)),
    [],
  );
  const fields = useMemo(() => fieldList(plugin), [plugin]);
  const promptField = fields.find((field) => field.id === 'prompt')
    ?? fields.find((field) => field.type === 'textarea' || field.type === 'text' || field.type === 'input');
  const prompt = promptField ? String(values[promptField.id] ?? '') : '';
  const missingRequiredField = fields.find((field) => {
    if (field.type === 'agent-select' || field.id === 'agentType') return false;
    return field.required && isEmptyPluginFieldValue(values[field.id], field);
  });
  const requestFields = fields
    .filter((field) => field.id !== promptField?.id && field.id !== 'agentType' && field.type !== 'agent-select')
    .map((field) => `${pluginFieldLabel(field)}: ${String(values[field.id] ?? '')}`)
    .join('\n');
  const canGenerate = !running && !missingRequiredField && Boolean(prompt.trim() || requestFields.trim());

  const handleOpenArtifact = useCallback(() => {
    if (!artifact) return;
    const opening = openWorkspaceSurface({
      index: 1,
      target: { kind: 'external', path: artifact.path, scopePath: null, transitionId: null },
    });
    void opening.catch((error) => {
      console.error('[AgentPluginWorkbench] Failed to open artifact', error);
    });
  }, [artifact]);

  useEffect(() => { ensurePluginRunStoreSubscription(); }, [plugin.manifest.id]);
  useEffect(() => {
    const notices: SurfaceNotice[] = [];
    if (running) notices.push({ id: 'plugin-generation', severity: 'info', message: { key: 'plugin.workbench.generating' } });
    if (error) notices.push({ id: 'plugin-generation-error', severity: 'error',
      message: { key: 'error.unexpected', fallbackText: error } });
    reportPresentation?.({ state: { status: 'ready', notices } });
  }, [error, reportPresentation, running]);
  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === canvasRef.current);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!canvasRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await canvasRef.current.requestFullscreen();
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!notebookPath) return;
    setRequestError(null);
    try {
      const context = [
        `当前笔记本路径: ${notebookPath}`,
        `当前笔记路径: ${currentNotePath || 'none'}`,
        '',
        '当前笔记内容（前5000字）:',
        currentNoteContent.slice(0, 5000) || 'none',
      ].join('\n');
      const request = [prompt.trim(), requestFields ? `## Additional configuration\n${requestFields}` : '']
        .filter(Boolean)
        .join('\n\n');
      const next = await runPlugin({
        pluginId: plugin.manifest.id,
        userPrompt: request,
        context,
        agentType: plugin.manifest.execution?.runtime || agentType,
        notebookPath,
        sourceNote: currentNotePath || undefined,
      });
      if (next.path) {
        // Completion belongs to the run store. Only an explicit, still-active
        // workbench may opt into opening the produced pointer memo; switching
        // notebook, memo, conversation, or plugin while the run continues
        // must not steal the workColumn back.
        const isCurrentWorkbenchContext = () => {
          const currentTarget = useWorkColumnStore.getState().navigation.target;
          const currentNotebook = useNoteStore.getState().selectedNotebook;
          return currentTarget.kind === 'plugin-workbench'
            && currentTarget.plugin.manifest.id === plugin.manifest.id
            && currentNotebook?.path != null
            && canonicalPath(currentNotebook.path) === canonicalPath(notebookPath);
        };
        if (!isCurrentWorkbenchContext()) return;
        const currentNotebook = useNoteStore.getState().selectedNotebook;
        if (currentNotebook && isCurrentWorkbenchContext()) {
          await openNotebookNote(next.path, currentNotebook);
        }
      }
    } catch (runError) {
      setRequestError(runError instanceof Error ? runError.message : String(runError));
    }
  }, [agentType, currentNoteContent, currentNotePath, notebookPath, plugin.manifest.execution?.runtime, plugin.manifest.id, prompt, requestFields, selectedNotebook]);

  if (!notebookPath || !selectedNotebook) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">请先选择一个笔记本</div>;
  }

  return (
    <div ref={canvasRef} className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[var(--document-bg)] [&:fullscreen]:h-screen">
      <div className="pointer-events-none absolute left-4 top-4 z-20">
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-[var(--divider)] bg-[var(--card)]/90 px-3 py-2 shadow-lg backdrop-blur">
          <button
            className="rounded-lg p-2 hover:bg-[var(--muted)]"
            onClick={() => setPanelOpen((open) => !open)}
            title={panelOpen ? '收起配置面板' : '打开配置面板'}
            aria-label={panelOpen ? '收起配置面板' : '打开配置面板'}
          >
            <SidebarSimpleIcon size={16} weight="bold" />
          </button>
          <div>
            <h1 className="text-sm font-semibold text-[var(--foreground)]">{plugin.manifest.name}</h1>
            {artifact?.name && <p className="text-[11px] text-[var(--muted-foreground)]">{artifact.name}</p>}
          </div>
        </div>
      </div>
      {hasCanvasControls && (
        <PluginMarkmapControls
          fullscreen={isFullscreen}
          onFit={() => rendererRef.current?.fit?.()}
          onZoomIn={() => rendererRef.current?.zoomIn?.()}
          onZoomOut={() => rendererRef.current?.zoomOut?.()}
          onOpenArtifact={artifact ? handleOpenArtifact : undefined}
          onToggleFullscreen={() => { void toggleFullscreen(); }}
        />
      )}
      {!hasCanvasControls && (
        <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-1 rounded-xl border border-[var(--divider)] bg-[var(--card)]/90 p-1 shadow-lg backdrop-blur">
          {artifact && <button className="rounded-lg p-2 hover:bg-[var(--muted)]" onClick={handleOpenArtifact} title="打开产物" aria-label="打开产物"><ArrowSquareOutIcon size={16} weight="bold" /></button>}
          <button className="rounded-lg p-2 hover:bg-[var(--muted)]" onClick={() => void toggleFullscreen()} title={isFullscreen ? '退出全屏' : '全屏'} aria-label={isFullscreen ? '退出全屏' : '全屏'}>{isFullscreen ? <CornersInIcon size={16} weight="bold" /> : <CornersOutIcon size={16} weight="bold" />}</button>
        </div>
      )}
      {panelOpen && (
        <div className="absolute bottom-4 left-4 top-20 z-10 flex min-h-0 w-[min(340px,calc(100%-2rem))] flex-col gap-4 overflow-y-auto rounded-2xl border border-[var(--divider)] bg-[var(--card)]/95 p-4 shadow-2xl backdrop-blur">
          {fields.map((field) => {
            const id = `plugin-${field.id}`;
            const isCheckbox = field.type === 'checkbox';
            return (
              <div key={field.id} className="flex flex-col gap-2">
                {!isCheckbox && <label className="text-sm font-medium text-[var(--foreground)]" htmlFor={id}>{pluginFieldLabel(field)}{field.required && <span className="ml-1 text-[var(--destructive)]">*</span>}</label>}
                <PluginFieldControl
                  field={field}
                  value={values[field.id]}
                  agentType={agentType}
                  agentOptions={agentOptions}
                  onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                  onAgentTypeChange={setAgentType}
                />
              </div>
            );
          })}
          <button disabled={!canGenerate} onClick={() => void handleGenerate()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--brand)] px-3 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-50">
            {running ? <SpinnerIcon size={16} weight="bold" className="flowix-spin" /> : <MagicWandIcon size={16} weight="bold" />}
            {running ? '生成中…' : runStatus === 'completed' ? '重新生成' : '生成插件产物'}
          </button>
          {missingRequiredField && <p className="text-xs text-[var(--muted-foreground)]">请填写必填项：{pluginFieldLabel(missingRequiredField)}</p>}
          {error && !reportPresentation && <p className="rounded-lg bg-[color-mix(in_oklch,var(--destructive)_10%,transparent)] p-3 text-xs text-[var(--destructive)]">{error}</p>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {artifact ? <PluginArtifactRenderer rendererRef={rendererRef} renderer={artifact.renderer} content={artifact.content || ''} /> : <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">输入提示词后开始生成</div>}
      </div>
    </div>
  );
}
