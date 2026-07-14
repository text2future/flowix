import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Braces, FileText, LoaderCircle, Network, Quote, Table2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createAgentMessageViewModel, shouldRenderAgentMessage } from '@features/agent/message';
import { useAgentConversationStore } from '@features/agent/store/agent-conversation-store';
import { useI18n } from '@features/i18n';
import { getAgentType, normalizeAgentTypeKey } from '@/lib/agent-types';
import type { MarkmapBlock, MarkmapBlockKind } from './markmap-data';

interface MarkmapInspectorProps {
  block: MarkmapBlock;
  onClose: () => void;
}

function MermaidPreview({ source }: { source: string }) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    if (hostRef.current) hostRef.current.replaceChildren();

    void import('@features/editor/extensions/codeblock-shiki/mermaid-renderer')
      .then(({ renderMermaidDiagram }) => renderMermaidDiagram(source))
      .then((svg) => {
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = svg;
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="document-markmap-inspector__diagram-error">
        <span>{t('document.markmap.diagramError')}</span>
        <pre>{source}</pre>
      </div>
    );
  }

  return (
    <div className="document-markmap-inspector__mermaid-wrap">
      <div ref={hostRef} className="document-markmap-inspector__mermaid">
        <LoaderCircle className="h-5 w-5 animate-spin text-[var(--muted-foreground)]" aria-hidden="true" />
        <span>{t('document.markmap.diagramLoading')}</span>
      </div>
    </div>
  );
}

function AgentPreview({ block }: { block: MarkmapBlock }) {
  const { language, t } = useI18n();
  const agentBlock = block.agent!;
  const instance = useAgentConversationStore((state) => {
    if (agentBlock.instanceId && state.instances[agentBlock.instanceId]) {
      return state.instances[agentBlock.instanceId];
    }
    if (!agentBlock.threadId) return null;
    return Object.values(state.instances).find((item) => item.threadId === agentBlock.threadId) ?? null;
  });
  const threadId = instance?.threadId || agentBlock.threadId;
  const messageState = useAgentConversationStore((state) => (
    threadId ? state.messageStates[threadId] ?? null : null
  ));
  const loadMessages = useAgentConversationStore((state) => state.loadMessages);
  const agentType = normalizeAgentTypeKey(instance?.agentType || agentBlock.agentType);
  const agent = getAgentType(agentType);
  const requestedThreadsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!threadId || requestedThreadsRef.current.has(threadId)) return;
    if (messageState?.messages.length || messageState?.loadingInitial) return;
    requestedThreadsRef.current.add(threadId);
    void loadMessages(agentType, threadId);
  }, [agentType, loadMessages, messageState, threadId]);

  const messages = useMemo(() => (
    (messageState?.messages ?? [])
      .filter(shouldRenderAgentMessage)
      .slice(-10)
      .map((message) => createAgentMessageViewModel(message, language))
  ), [language, messageState?.messages]);

  return (
    <div className="document-markmap-agent-card">
      <div className="document-markmap-agent-card__header">
        <span className="document-markmap-agent-card__icon">
          <img src={agent.icon} alt="" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--foreground)]">
            {instance?.title || agentBlock.title || agent.name}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
            <span>{agent.name}</span>
            {(instance?.role?.name || agentBlock.agentRoleName) && (
              <><span>·</span><span>{instance?.role?.name || agentBlock.agentRoleName}</span></>
            )}
            {instance?.run?.status === 'running' && (
              <span className="document-markmap-agent-card__running">
                <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                {t('document.markmap.agentRunning')}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="document-markmap-agent-card__messages">
        {messageState?.loadingInitial && messages.length === 0 ? (
          <div className="document-markmap-agent-card__empty">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('document.markmap.agentLoading')}
          </div>
        ) : messages.length > 0 ? messages.map((message) => (
          <article
            key={message.message.id}
            className={`document-markmap-agent-message document-markmap-agent-message--${message.role}`}
          >
            <div className="document-markmap-agent-message__role">
              {message.role === 'user'
                ? t('document.markmap.agentUser')
                : message.role === 'assistant'
                  ? agent.name
                  : message.role === 'reasoning'
                    ? message.reasoningLabel
                    : message.toolLabel || message.role}
            </div>
            {message.role === 'tool' ? (
              <div className="text-xs text-[var(--muted-foreground)]">
                {message.toolSummary || message.visibleContent}
              </div>
            ) : (
              <div className="document-markmap-rich-text">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.visibleContent}
                </ReactMarkdown>
              </div>
            )}
          </article>
        )) : (
          <div className="document-markmap-agent-card__empty">
            <Bot className="h-4 w-4" aria-hidden="true" />
            {t('document.markmap.agentEmpty')}
          </div>
        )}
      </div>

      {agentBlock.inputDraft && (
        <div className="document-markmap-agent-card__draft">
          <span>{t('document.markmap.agentDraft')}</span>
          <div>{agentBlock.inputDraft}</div>
        </div>
      )}
    </div>
  );
}

function blockLabel(kind: MarkmapBlockKind, t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<MarkmapBlockKind, string> = {
    heading: t('document.markmap.blockHeading'),
    paragraph: t('document.markmap.blockText'),
    list: t('document.markmap.blockList'),
    mermaid: t('document.markmap.blockDiagram'),
    code: t('document.markmap.blockCode'),
    agent: t('document.markmap.blockAgent'),
    blockquote: t('document.markmap.blockQuote'),
    table: t('document.markmap.blockTable'),
    frontmatter: t('document.markmap.blockProperties'),
    separator: t('document.markmap.blockSeparator'),
    html: t('document.markmap.blockHtml'),
  };
  return labels[kind];
}

function BlockIcon({ kind }: { kind: MarkmapBlockKind }) {
  if (kind === 'mermaid') return <Network className="h-4 w-4" aria-hidden="true" />;
  if (kind === 'agent') return <Bot className="h-4 w-4" aria-hidden="true" />;
  if (kind === 'code' || kind === 'html') return <Braces className="h-4 w-4" aria-hidden="true" />;
  if (kind === 'blockquote') return <Quote className="h-4 w-4" aria-hidden="true" />;
  if (kind === 'table') return <Table2 className="h-4 w-4" aria-hidden="true" />;
  return <FileText className="h-4 w-4" aria-hidden="true" />;
}

export function MarkmapInspector({ block, onClose }: MarkmapInspectorProps) {
  const { t } = useI18n();
  return (
    <aside className="document-markmap-inspector" aria-label={t('document.markmap.preview')}>
      <header className="document-markmap-inspector__header">
        <span className={`document-markmap-inspector__kind document-markmap-inspector__kind--${block.kind}`}>
          <BlockIcon kind={block.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
            {blockLabel(block.kind, t)}
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold text-[var(--foreground)]">
            {block.title}
          </div>
        </div>
        <button
          type="button"
          className="document-markmap-inspector__close"
          onClick={onClose}
          aria-label={t('document.markmap.closePreview')}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="document-markmap-inspector__body">
        {block.kind === 'mermaid' ? (
          <MermaidPreview source={block.markdown} />
        ) : block.kind === 'agent' ? (
          <AgentPreview block={block} />
        ) : block.kind === 'code' ? (
          <pre className="document-markmap-inspector__code"><code>{block.markdown}</code></pre>
        ) : block.kind === 'frontmatter' ? (
          <pre className="document-markmap-inspector__code"><code>{block.markdown}</code></pre>
        ) : block.kind === 'separator' ? (
          <hr className="my-8 border-[var(--border)]" />
        ) : (
          <div className="document-markmap-rich-text">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {block.markdown}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </aside>
  );
}
