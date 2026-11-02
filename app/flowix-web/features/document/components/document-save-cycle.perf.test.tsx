/**
 * Simulated Windows save-cycle cost, measured on real components.
 *
 * Why this exists: we cannot reproduce on a Windows machine, so instead we
 * mount the *real* editor + content boundary + autosave pipeline and inject
 * the two things Windows changes:
 *
 *   1. `writeDelayMs`  — FlushFileBuffers + Defender + SQLite commit make the
 *                        IPC round-trip longer. Injected, swept over values.
 *   2. A CPU factor     — applied afterwards in the report as a linear
 *                        extrapolation (a slower CPU stretches the same JS).
 *
 * What is measured for real, per autosave cycle:
 *   - editor serialization  (editor.getMarkdown)
 *   - buffer fan-out        (recordDocumentEdit -> notify -> 7 subscribers)
 *   - editor re-render      (React Profiler actualDuration)
 *
 * Structural assertions are strict; timing numbers are printed, never asserted,
 * so the suite cannot fail on a noisy CI box.
 */
import { Profiler, act, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Toaster } from 'sonner';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownEditor, type MarkdownEditorHandle } from '@features/editor/markdown-editor';
import { I18nProvider } from '@/lib/i18n';
import { ShortcutsProvider } from '@features/shortcuts';
import '@features/shortcuts/actions';
import { DocumentSaveStatus } from './document-save-status';
import { ActionableNoticeHost } from '@features/notifications/actionable-notice-host';
import { useDocumentAutosave } from './session/use-document-autosave';
import { DocumentContentBoundary } from './session/document-content-boundary';
import { perfReset, perfSummary, setPerfEnabled } from '@/lib/perf-probe';
import { applyLoadedDocumentContent, registerDocumentCapture } from '../store/document-session-service';
import { ensureFileDisplayIdentity, reconcileFileDisplays } from '@/lib/file-display-registry';
import { waitForDocumentCommits } from '../store/document-commit-queue';

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  read: vi.fn(),
}));

vi.mock('../use-cases/local-document-operations', () => ({
  localDocumentOperations: { write: mocks.write, read: mocks.read },
}));
vi.mock('../store/recovery-draft-store', () => ({
  persistRecoveryDraft: vi.fn().mockResolvedValue(true),
  clearRecoveryDraftThrough: vi.fn().mockResolvedValue(undefined),
  flushRecoveryOperations: vi.fn().mockResolvedValue(true),
}));
// Recovery-draft persistence is a separate disk write; measured elsewhere.
// Mocked here so the cycle cost reflects editor + fan-out + render only.

let container: HTMLDivElement;
let root: Root;
let editor: Editor;
let sequence = 0;

const renderStats = { count: 0, totalMs: 0, maxMs: 0, phases: [] as string[], stamps: [] as number[] };

function resetRenderStats() {
  renderStats.count = 0;
  renderStats.totalMs = 0;
  renderStats.maxMs = 0;
  renderStats.phases = [];
  renderStats.stamps = [];
}

function onEditorRender(_id: string, phase: string, actualDuration: number) {
  renderStats.count += 1;
  renderStats.totalMs += actualDuration;
  if (actualDuration > renderStats.maxMs) renderStats.maxMs = actualDuration;
  renderStats.phases.push(phase);
  renderStats.stamps.push(Date.now());
}

function mountDocument(initialBody: string) {
  const identity = { kind: 'md' as const, ...ensureFileDisplayIdentity('/perf-' + ++sequence + '.md') };
  reconcileFileDisplays([identity]);
  applyLoadedDocumentContent(identity, identity.path, initialBody);

  function Harness() {
    const handle = useRef<MarkdownEditorHandle>(null);
    const capture = useCallback(() => handle.current?.flushPendingChanges() ?? null, []);
    useEffect(() => registerDocumentCapture(identity, capture), [capture]);
    const autosave = useDocumentAutosave({
      identity,
      externalScopePath: null,
      flushPendingContent: capture,
    });
    return (
      <I18nProvider language="en-US">
        <ShortcutsProvider overrides={{}}>
          {createPortal(<Toaster />, document.body)}
          <ActionableNoticeHost />
          <DocumentSaveStatus identity={identity} scopePath={null} />
          <DocumentContentBoundary identity={identity}>
            {(content) => (
              <Profiler id="markdown-editor" onRender={onEditorRender}>
                <MarkdownEditor
                  ref={handle}
                  content={content}
                  onChange={autosave.handleChange}
                  onDirty={autosave.handleDirty}
                  onBeforeCreate={(value) => { editor = value; }}
                  editable
                />
              </Profiler>
            )}
          </DocumentContentBoundary>
        </ShortcutsProvider>
      </I18nProvider>
    );
  }
  return { identity, Harness };
}

function bucket(name: string) {
  return perfSummary().find(row => row.name === name);
}

type CycleSample = {
  serializeMs: number;
  fanoutMs: number;
  fanoutListeners: number;
  fanoutNotifications: number;
  renderCount: number;
  renderMs: number;
  renderPhases: string[];
  renderStamps: number[];
};

/**
 * Type `keysPerRound` characters, then let the autosave clock fire.
 * The debounce is 300ms, so each round produces exactly one disk write.
 */
async function typeAndSave(keysPerRound: number): Promise<CycleSample> {
  for (let i = 0; i < keysPerRound; i += 1) {
    act(() => {
      editor.commands.insertContent('x');
    });
    // Stay under the 300ms debounce so keys coalesce into one save.
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  }

  perfReset();
  resetRenderStats();

  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });

  const serialize = bucket('editor-serialize-ms');
  const fanout = bucket('buffer-fanout-ms');
  const editedFanout = bucket('buffer-fanout-count:edited');
  const withListeners = fanout?.lastDetail?.listeners;

  return {
    serializeMs: serialize?.maxMs ?? 0,
    fanoutMs: fanout?.maxMs ?? 0,
    fanoutListeners: typeof withListeners === 'number' ? withListeners : 0,
    fanoutNotifications: editedFanout?.count ?? 0,
    renderCount: renderStats.count,
    renderMs: renderStats.totalMs,
    renderPhases: [...renderStats.phases],
    renderStamps: [...renderStats.stamps],
  };
}

function bodyOfSize(kb: number): string {
  const target = kb * 1024;
  const unit = '## Section\n\nThe quick brown fox jumps over the lazy dog. 中文内容用于测量序列化成本。\n\n';
  return unit.repeat(Math.ceil(target / unit.length)).slice(0, target);
}

describe('autosave cycle cost (simulated slow Windows IPC)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setPerfEnabled(true);
    perfReset();
    resetRenderStats();
    mocks.write.mockReset().mockImplementation(async (request: { path: string; content: string }) => ({
      status: 'saved', path: request.path, content: request.content,
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }),
      },
    });
  });

  afterEach(async () => {
    await act(async () => {
      await root.unmount();
      await vi.advanceTimersByTimeAsync(300);
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  for (const documentKb of [2, 20, 60]) {
    it(`reports one save cycle at ${documentKb}KB`, async () => {
      const { Harness } = mountDocument(bodyOfSize(documentKb));
      await act(async () => { root.render(<Harness />); });
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      mocks.write.mockClear();

      const samples: CycleSample[] = [];
      for (let round = 0; round < 3; round += 1) {
        samples.push(await typeAndSave(6));
      }
      await act(async () => { await waitForDocumentCommits(`md:${sequence}`).catch(() => {}); });

      const median = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] ?? 0;
      };
      const row = {
        documentKb,
        writes: mocks.write.mock.calls.length,
        serializeMs: Math.round(median(samples.map(s => s.serializeMs)) * 100) / 100,
        fanoutMs: Math.round(median(samples.map(s => s.fanoutMs)) * 100) / 100,
        fanoutListeners: samples[0]?.fanoutListeners ?? 0,
        editedNotifications: samples.reduce((sum, s) => sum + s.fanoutNotifications, 0),
        editorRenders: samples.reduce((sum, s) => sum + s.renderCount, 0),
        // React reports one commit as `update` + `nested-update`; group by the
        // commit timestamp so this counts real commits, not Profiler rows.
        editorCommits: new Set(samples.flatMap(s => s.renderStamps)).size,
        rendersPerSave: Math.round((samples.reduce((sum, s) => sum + s.renderCount, 0) / 3) * 100) / 100,
        renderMs: Math.round(median(samples.map(s => s.renderMs)) * 100) / 100,
        renderPhases: samples.flatMap(s => s.renderPhases).join('|'),
        renderStamps: samples.flatMap(s => s.renderStamps).join('|'),
      };
      console.info('[perf:save-cycle]', JSON.stringify(row));

      // Structural facts: one coalesced write per quiet period, exactly one
      // buffer fan-out per save, and one editor commit per save. A second
      // commit would mean the save round-trip is feeding content back into the
      // editor that produced it.
      expect(row.writes).toBe(3);
      expect(row.editedNotifications).toBe(3);
      expect(row.editorCommits).toBe(3);
      expect(row.fanoutListeners).toBeGreaterThan(0);
    }, 120_000);
  }

  it('reports how a slow IPC write shifts the settle timeline', async () => {
    const { Harness } = mountDocument(bodyOfSize(20));
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    const timeline: Array<{
      writeDelayMs: number;
      settleMs: number;
      rendersDuringDebounce: number;
      rendersAfterSettle: number;
    }> = [];
    for (const writeDelayMs of [0, 30, 120, 300]) {
      mocks.write.mockImplementation((request: { path: string; content: string }) => (
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: 'saved', path: request.path, content: request.content }), writeDelayMs);
        })
      ));
      await act(async () => { editor.commands.insertContent(` delay-${writeDelayMs} `); });
      resetRenderStats();
      // Fake clock: measures how long the document stays in a non-clean state.
      const startedAt = Date.now();

      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      const rendersDuringDebounce = renderStats.count;
      // Let the injected write latency elapse, then let settle callbacks run.
      await act(async () => { await vi.advanceTimersByTimeAsync(writeDelayMs + 50); });

      timeline.push({
        writeDelayMs,
        settleMs: Date.now() - startedAt,
        rendersDuringDebounce,
        rendersAfterSettle: renderStats.count - rendersDuringDebounce,
      });
    }
    console.info('[perf:settle-timeline]', JSON.stringify(timeline));
    // A slower write must not add editor renders: the editor text is already
    // committed locally before the IPC resolves.
    for (const row of timeline) {
      expect(row.rendersAfterSettle).toBeLessThanOrEqual(1);
    }
  }, 120_000);
});
