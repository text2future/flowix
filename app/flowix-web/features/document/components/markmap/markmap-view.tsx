'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Focus, GitFork, Maximize2, Minimize2, Minus, Plus, ScanText } from 'lucide-react';
import { Markmap } from 'markmap-view';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@features/i18n';
import { MarkmapInspector } from './markmap-inspector';
import { buildMarkmapDocument, hasMarkmapContent } from './markmap-data';

interface MarkmapViewProps {
  content: string;
}

const BRANCH_COLORS = [
  'var(--markmap-branch-1)',
  'var(--markmap-branch-2)',
  'var(--markmap-branch-3)',
  'var(--markmap-branch-4)',
];

type RuntimeNode = NonNullable<Parameters<Markmap['setHighlight']>[0]>;

interface D3ZoomState {
  k: number;
}

function getCurrentScale(svg: SVGSVGElement): number {
  return (svg as SVGSVGElement & { __zoom?: D3ZoomState }).__zoom?.k ?? 1;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

export function MarkmapView({ content }: MarkmapViewProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const markmapRef = useRef<Markmap | null>(null);
  const selectedNodeRef = useRef<RuntimeNode | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const documentData = useMemo(
    () => buildMarkmapDocument(content, t('document.markmap.fallbackTitle')),
    [content, t],
  );
  const hasContent = useMemo(() => hasMarkmapContent(documentData), [documentData]);
  const selectedBlock = selectedBlockId ? documentData.blocks[selectedBlockId] ?? null : null;

  const fit = useCallback(() => {
    void markmapRef.current?.fit();
  }, []);

  const fitForReading = useCallback(async () => {
    const markmap = markmapRef.current;
    const svg = svgRef.current;
    if (!markmap || !svg) return;

    await markmap.fit(1);
    const viewport = svg.getBoundingClientRect();
    const readingScale = viewport.width < 760 ? 0.82 : viewport.width < 1180 ? 0.9 : 1;
    const currentScale = getCurrentScale(svg);
    if (currentScale < readingScale) {
      await markmap.rescale(readingScale / currentScale);
    }

    const focusNode = selectedNodeRef.current ?? markmap.state.data;
    if (focusNode) {
      await markmap.centerNode(focusNode, {
        left: Math.max(24, viewport.width * 0.08),
        right: viewport.width * 0.64,
        top: 56,
        bottom: 56,
      });
    }
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !hasContent) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const markmap = Markmap.create(svg, {
      autoFit: true,
      duration: reduceMotion ? 0 : 260,
      embedGlobalCSS: true,
      fitRatio: 0.88,
      initialExpandLevel: -1,
      maxInitialScale: 1.2,
      maxWidth: 360,
      nodeMinHeight: 24,
      paddingX: 12,
      pan: true,
      scrollForPan: false,
      spacingHorizontal: 92,
      spacingVertical: 10,
      toggleRecursively: false,
      zoom: true,
      color: (node) => BRANCH_COLORS[node.state.depth % BRANCH_COLORS.length],
      lineWidth: (node) => node.state.depth === 1 ? 2 : 1.4,
    }, documentData.root);
    markmapRef.current = markmap;

    const selectNode = (node: RuntimeNode) => {
      const blockId = node.payload?.blockId;
      if (typeof blockId !== 'string' || !documentData.blocks[blockId]) return;
      selectedNodeRef.current = node;
      setSelectedBlockId(blockId);
      void markmap.setHighlight(node);
    };
    const getPreviewNode = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const previewTarget = target.closest('.document-markmap-node-content, .document-markmap-heading-text');
      if (!previewTarget) return null;
      const nodeElement = previewTarget.closest<SVGGElement>('.markmap-node');
      if (!nodeElement || !svg.contains(nodeElement)) return null;
      return (nodeElement as SVGGElement & { __data__?: RuntimeNode }).__data__ ?? null;
    };
    const handleNodeClick = (event: MouseEvent) => {
      const node = getPreviewNode(event.target);
      if (node) selectNode(node);
    };
    const handleNodeKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const node = getPreviewNode(event.target);
      if (!node) return;
      event.preventDefault();
      selectNode(node);
    };
    svg.addEventListener('click', handleNodeClick, true);
    svg.addEventListener('keydown', handleNodeKeyDown, true);

    const frame = requestAnimationFrame(() => void markmap.fit());
    return () => {
      cancelAnimationFrame(frame);
      svg.removeEventListener('click', handleNodeClick, true);
      svg.removeEventListener('keydown', handleNodeKeyDown, true);
      markmap.destroy();
      if (markmapRef.current === markmap) markmapRef.current = null;
      selectedNodeRef.current = null;
    };
  }, [documentData, hasContent]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasContent) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const markmap = markmapRef.current;
        const selectedNode = selectedNodeRef.current;
        if (markmap && selectedNode) {
          void markmap.ensureVisible(selectedNode, { left: 24, right: 24, top: 24, bottom: 72 });
        } else {
          fit();
        }
      });
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [fit, hasContent]);

  useEffect(() => {
    if (selectedBlockId && !documentData.blocks[selectedBlockId]) {
      setSelectedBlockId(null);
    }
  }, [documentData.blocks, selectedBlockId]);

  useEffect(() => {
    if (!isFullscreen && !selectedBlock) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (selectedBlock) {
        selectedNodeRef.current = null;
        setSelectedBlockId(null);
        void markmapRef.current?.setHighlight();
      } else {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, selectedBlock]);

  useEffect(() => {
    if (!hasContent) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'r' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      void fitForReading();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fitForReading, hasContent]);

  useEffect(() => {
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fit, isFullscreen]);

  const iconButtonClass =
    'inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-40';

  return (
    <div
      ref={hostRef}
      className={`document-markmap${isFullscreen ? ' document-markmap--fullscreen' : ''}${selectedBlock ? ' document-markmap--inspecting' : ''}`}
      aria-label={t('document.markmap.canvas')}
    >
      <div ref={canvasRef} className="document-markmap__canvas">
        {hasContent ? (
          <svg
            ref={svgRef}
            className="document-markmap__svg markmap"
            role="img"
            aria-label={t('document.markmap.diagram')}
          />
        ) : (
          <div className="document-markmap__empty" role="status">
            <span className="document-markmap__empty-icon" aria-hidden="true">
              <GitFork className="h-6 w-6" />
            </span>
            <div className="text-sm font-medium text-[var(--foreground)]">
              {t('document.markmap.emptyTitle')}
            </div>
            <div className="max-w-sm text-center text-xs text-[var(--muted-foreground)]">
              {t('document.markmap.emptyDescription')}
            </div>
          </div>
        )}

        {hasContent && (
          <div className="document-markmap__hint">
            {t('document.markmap.hint')}
          </div>
        )}

        <div
          className="document-markmap__controls"
          role="toolbar"
          aria-label={t('document.markmap.controls')}
        >
          <Tooltip content={t('document.markmap.zoomOut')}>
            <button
              type="button"
              className={iconButtonClass}
              onClick={() => void markmapRef.current?.rescale(0.8)}
              disabled={!hasContent}
              aria-label={t('document.markmap.zoomOut')}
            >
              <Minus className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={t('document.markmap.fit')}>
            <button
              type="button"
              className={iconButtonClass}
              onClick={fit}
              disabled={!hasContent}
              aria-label={t('document.markmap.fit')}
            >
              <Focus className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={t('document.markmap.fitReading')}>
            <button
              type="button"
              className={iconButtonClass}
              onClick={() => void fitForReading()}
              disabled={!hasContent}
              aria-label={t('document.markmap.fitReading')}
            >
              <ScanText className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={t('document.markmap.zoomIn')}>
            <button
              type="button"
              className={iconButtonClass}
              onClick={() => void markmapRef.current?.rescale(1.25)}
              disabled={!hasContent}
              aria-label={t('document.markmap.zoomIn')}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tooltip>
          <span className="document-markmap__control-divider" aria-hidden="true" />
          <Tooltip content={isFullscreen ? t('document.markmap.exitFullscreen') : t('document.markmap.fullscreen')}>
            <button
              type="button"
              className={iconButtonClass}
              onClick={() => setIsFullscreen((value) => !value)}
              aria-label={isFullscreen ? t('document.markmap.exitFullscreen') : t('document.markmap.fullscreen')}
            >
              {isFullscreen ? (
                <Minimize2 className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        </div>
      </div>

      {selectedBlock && (
        <MarkmapInspector
          block={selectedBlock}
          onClose={() => {
            selectedNodeRef.current = null;
            setSelectedBlockId(null);
            void markmapRef.current?.setHighlight();
          }}
        />
      )}
    </div>
  );
}
