'use client';

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, type ComponentType, type Ref } from 'react';
import type { Markmap } from 'markmap-view';
import type { PluginArtifactRendererId } from './plugin-renderer-ids';

const MARKMAP_BRANCH_COLORS = [
  'var(--plugin-markmap-branch-1)',
  'var(--plugin-markmap-branch-2)',
  'var(--plugin-markmap-branch-3)',
  'var(--plugin-markmap-branch-4)',
];

export interface PluginArtifactRendererHandle {
  fit?: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
}

export type PluginArtifactRendererProps = {
  content: string;
  rendererRef?: Ref<PluginArtifactRendererHandle>;
};

type RendererProps = PluginArtifactRendererProps;

function MarkmapRenderer({ content, rendererRef }: RendererProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const markmapRef = useRef<Markmap | null>(null);

  const fit = useCallback(() => {
    void markmapRef.current?.fit();
  }, []);

  useImperativeHandle(rendererRef, () => ({
    fit,
    zoomIn: () => { void markmapRef.current?.rescale(1.2); },
    zoomOut: () => { void markmapRef.current?.rescale(0.8); },
  }), [fit]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.replaceChildren();
    let disposed = false;
    let markmap: Markmap | null = null;
    let frame: number | null = null;

    // 懒加载 markmap (连同传递依赖 d3 + marked) ── 只在真正渲染 markmap
    // 产物时拉取, 避免其 ~678K 进入插件/编辑器主 chunk。异步 gap 用
    // disposed 标志 + 局部 markmap/frame 变量交给 cleanup 兜底。
    void (async () => {
      const [{ Transformer }, { Markmap: MarkmapCtor }] = await Promise.all([
        import('markmap-lib'),
        import('markmap-view'),
      ]);
      if (disposed || !svgRef.current) return;

      const transformer = new Transformer();
      const { root } = transformer.transform(content);
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      markmap = MarkmapCtor.create(svgRef.current, {
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
        color: (node) => MARKMAP_BRANCH_COLORS[node.state.depth % MARKMAP_BRANCH_COLORS.length],
        lineWidth: (node) => node.state.depth === 1 ? 2 : 1.4,
      }, root);
      markmapRef.current = markmap;
      frame = requestAnimationFrame(fit);
    })().catch((error: unknown) => {
      console.error('[MarkmapRenderer] failed to load markmap:', error);
    });

    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      markmap?.destroy();
      markmapRef.current = null;
      svg.replaceChildren();
    };
  }, [content, fit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [fit]);

  return (
    <div ref={canvasRef} className="plugin-markmap-canvas">
      <svg ref={svgRef} className="plugin-markmap-canvas__svg markmap" role="img" aria-label="思维导图" />
    </div>
  );
}

function JsonRenderer({ content }: RendererProps) {
  let formatted = content;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    // The backend validates JSON outputs; retain a readable fallback for old artifacts.
  }
  return <pre className="h-full overflow-auto whitespace-pre-wrap p-6 text-sm">{formatted}</pre>;
}

function HtmlRenderer({ content }: RendererProps) {
  return (
    <iframe
      title="Plugin HTML output"
      className="h-full w-full border-0 bg-white"
      sandbox=""
      srcDoc={content}
    />
  );
}

const WEBPAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join('; ');

export function sandboxWebpageContent(content: string): string {
  const parsed = new DOMParser().parseFromString(content, 'text/html');
  const policy = parsed.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = WEBPAGE_CSP;

  // Keep navigation inside the artifact. The iframe sandbox already blocks
  // popups and top-level navigation; this capture guard also stops ordinary
  // links and forms from replacing the artifact's own browsing context.
  const navigationGuard = parsed.createElement('script');
  navigationGuard.textContent = `
    document.addEventListener('click', function (event) {
      var target = event.target;
      var link = target && target.closest ? target.closest('a[href]') : null;
      if (!link) return;
      var href = link.getAttribute('href') || '';
      if (!href.startsWith('#')) event.preventDefault();
    }, true);
    document.addEventListener('submit', function (event) {
      event.preventDefault();
    }, true);
  `;

  parsed.head.prepend(navigationGuard);
  parsed.head.prepend(policy);
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

function WebpageRenderer({ content }: RendererProps) {
  const sandboxedContent = useMemo(() => sandboxWebpageContent(content), [content]);

  return (
    <iframe
      title="Plugin webpage"
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={sandboxedContent}
    />
  );
}

function TextRenderer({ content }: RendererProps) {
  return <pre className="h-full overflow-auto whitespace-pre-wrap p-6 text-sm">{content}</pre>;
}

export interface PluginArtifactRendererDefinition {
  component: ComponentType<RendererProps>;
}

/** Host-owned Renderer registry. Manifest values select audited components;
 * third-party plugins do not inject React or editor implementations. */
export const pluginArtifactRendererRegistry = Object.freeze({
  markmap: { component: MarkmapRenderer },
  'json-viewer': { component: JsonRenderer },
  html: { component: HtmlRenderer },
  webpage: { component: WebpageRenderer },
  markdown: { component: TextRenderer },
  text: { component: TextRenderer },
} satisfies Record<PluginArtifactRendererId, PluginArtifactRendererDefinition>);

export type RegisteredPluginArtifactRendererId = keyof typeof pluginArtifactRendererRegistry;

export function getPluginArtifactRendererDefinition(
  renderer: string,
): PluginArtifactRendererDefinition | null {
  return Object.prototype.hasOwnProperty.call(pluginArtifactRendererRegistry, renderer)
    ? pluginArtifactRendererRegistry[renderer as RegisteredPluginArtifactRendererId]
    : null;
}

export const PluginArtifactRenderer = ({
  renderer,
  content,
  rendererRef,
}: {
  renderer: string;
  content: string;
  rendererRef?: Ref<PluginArtifactRendererHandle>;
}) => {
  const definition = getPluginArtifactRendererDefinition(renderer);
  const Renderer = definition?.component ?? TextRenderer;
  return <Renderer content={content} rendererRef={rendererRef} />;
};
