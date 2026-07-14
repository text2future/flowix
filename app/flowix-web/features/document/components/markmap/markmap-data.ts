import { marked, type Token, type Tokens } from 'marked';
import { Transformer } from 'markmap-lib';

const inlineTransformer = new Transformer();

export type MarkmapBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'mermaid'
  | 'code'
  | 'agent'
  | 'blockquote'
  | 'table'
  | 'frontmatter'
  | 'separator'
  | 'html';

export interface MarkmapAgentBlock {
  instanceId: string | null;
  threadId: string | null;
  title: string;
  agentType: string;
  agentRoleName: string | null;
  inputDraft: string | null;
}

export interface MarkmapBlock {
  id: string;
  kind: MarkmapBlockKind;
  title: string;
  markdown: string;
  language?: string | null;
  agent?: MarkmapAgentBlock;
  synthetic?: boolean;
}

export interface MarkmapNodePayload {
  blockId: string;
  kind: MarkmapBlockKind;
  fold?: number;
  [key: string]: unknown;
}

export interface MarkmapRoot {
  content: string;
  children: MarkmapRoot[];
  payload?: MarkmapNodePayload;
}

export interface MarkmapDocument {
  root: MarkmapRoot;
  blocks: Record<string, MarkmapBlock>;
}

interface HeadingFrame {
  depth: number;
  node: MarkmapRoot;
}

const AGENT_CARD_RE = /^::agent-thread-card\{([^}]*)\}[ \t]*$/;
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRawHtml(markdown: string): string {
  return markdown.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(markdown: string): string {
  const singleLine = escapeRawHtml(markdown).replace(/\s*\n\s*/g, ' ').trim();
  if (!singleLine) return '';
  const transformed = inlineTransformer.transform(`- ${singleLine}`).root;
  return transformed.content || escapeHtml(singleLine);
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarize(markdown: string, limit = 220): string {
  const value = plainText(markdown);
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
}

function nodeBadge(kind: MarkmapBlockKind, label: string): string {
  return `<span class="document-markmap-node-badge document-markmap-node-badge--${kind}">${escapeHtml(label)}</span>`;
}

function nodeContent(kind: MarkmapBlockKind, label: string, markdown: string): string {
  const summary = summarize(markdown);
  const content = renderInline(summary || label);
  const accessibleText = escapeHtml(`${label}: ${summary || label}`);
  return `<span class="document-markmap-node-content document-markmap-node-content--${kind}" role="button" tabindex="0" aria-label="${accessibleText}">${nodeBadge(kind, label)}<span class="document-markmap-node-text">${content}</span></span>`;
}

function headingContent(markdown: string): string {
  const text = plainText(markdown);
  return `<span class="document-markmap-heading-text" role="button" tabindex="0" aria-label="${escapeHtml(text)}">${renderInline(markdown) || escapeHtml(text)}</span>`;
}

function unescapeAgentAttr(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseAgentAttrs(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /(\w+)="((?:\\"|\\\\|[^"])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(rawAttrs))) {
    attrs[match[1]] = unescapeAgentAttr(match[2]);
  }
  return attrs;
}

function decodeInputDraft(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseAgentBlock(markdown: string): MarkmapAgentBlock | null {
  const match = AGENT_CARD_RE.exec(markdown.trim());
  if (!match) return null;
  const attrs = parseAgentAttrs(match[1]);
  return {
    instanceId: attrs.instanceId || null,
    threadId: attrs.threadId || null,
    title: attrs.title || '',
    agentType: attrs.agentType || 'flowix',
    agentRoleName: attrs.agentRoleName || null,
    inputDraft: decodeInputDraft(attrs.inputDraft),
  };
}

function mermaidTitle(source: string): string {
  const firstLine = source.trim().split(/\r?\n/, 1)[0]?.toLowerCase() ?? '';
  if (firstLine.startsWith('sequencediagram')) return 'Sequence';
  if (firstLine.startsWith('statediagram')) return 'State';
  if (firstLine.startsWith('classdiagram')) return 'Class';
  if (firstLine.startsWith('erdiagram')) return 'ER';
  if (firstLine.startsWith('gantt')) return 'Gantt';
  if (firstLine.startsWith('pie')) return 'Pie';
  if (firstLine.startsWith('mindmap')) return 'Mindmap';
  return 'Flowchart';
}

function mermaidSummary(source: string): string {
  const lines = source
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !/^(classDef|class|style|linkStyle|click)\b/i.test(line))
    .slice(0, 4)
    .map((line) => line
      .replace(/\b[A-Za-z_]\w*\[([^\]]+)]/g, '$1')
      .replace(/\b[A-Za-z_]\w*\(([^)]+)\)/g, '$1')
      .replace(/\b[A-Za-z_]\w*\{([^}]+)}/g, '$1')
      .replace(/[-=.]+(?:\|[^|]*\|)?\s*>/g, ' → ')
      .replace(/\s+/g, ' '));
  return lines.join(' · ') || mermaidTitle(source);
}

function tokenText(token: Token): string {
  if ('text' in token && typeof token.text === 'string') return token.text;
  return token.raw?.trim() ?? '';
}

function listItemOwnMarkdown(item: Tokens.ListItem): string {
  const ownTokens = item.tokens.filter((token) => token.type !== 'list');
  const text = ownTokens.map(tokenText).filter(Boolean).join('\n').trim();
  return text || item.text.trim();
}

function isListToken(token: Token): token is Tokens.List {
  return token.type === 'list' && 'items' in token && Array.isArray(token.items);
}

function isTableToken(token: Token): token is Tokens.Table {
  return token.type === 'table' && 'header' in token && Array.isArray(token.header);
}

export function buildMarkmapDocument(
  markdown: string,
  fallbackTitle = 'Document',
): MarkmapDocument {
  let body = markdown;
  let frontmatter: string | null = null;
  const frontmatterMatch = FRONTMATTER_RE.exec(markdown);
  if (frontmatterMatch) {
    frontmatter = frontmatterMatch[1].trim();
    body = markdown.slice(frontmatterMatch[0].length);
  }

  const tokens = marked.lexer(body, { gfm: true });
  const rootHeading = tokens.find(
    (token): token is Tokens.Heading => token.type === 'heading' && token.depth === 1,
  ) ?? tokens.find((token): token is Tokens.Heading => token.type === 'heading');

  const blocks: Record<string, MarkmapBlock> = {};
  let blockSequence = 0;
  const createNode = (
    kind: MarkmapBlockKind,
    title: string,
    source: string,
    content: string,
    extra?: Partial<MarkmapBlock>,
  ): MarkmapRoot => {
    const id = `markmap-block-${blockSequence++}`;
    blocks[id] = { id, kind, title, markdown: source, ...extra };
    return {
      content,
      children: [],
      payload: { blockId: id, kind },
    };
  };

  const rootTitle = rootHeading?.text?.trim() || fallbackTitle;
  const root = createNode(
    'heading',
    rootTitle,
    rootHeading?.raw?.trim() || rootTitle,
    headingContent(rootTitle),
    { synthetic: !rootHeading },
  );
  const headingStack: HeadingFrame[] = [{ depth: rootHeading?.depth ?? 0, node: root }];

  const attach = (node: MarkmapRoot) => {
    headingStack[headingStack.length - 1].node.children.push(node);
  };

  const addList = (list: Tokens.List, parent: MarkmapRoot) => {
    for (const item of list.items) {
      const ownMarkdown = listItemOwnMarkdown(item);
      const label = item.task ? (item.checked ? 'Done' : 'Todo') : (list.ordered ? 'Step' : 'Item');
      const itemNode = createNode(
        'list',
        summarize(ownMarkdown, 80) || label,
        item.raw.trim(),
        nodeContent('list', label, ownMarkdown),
      );
      parent.children.push(itemNode);
      for (const childToken of item.tokens) {
        if (isListToken(childToken)) addList(childToken, itemNode);
      }
    }
  };

  if (frontmatter) {
    attach(createNode(
      'frontmatter',
      'Properties',
      frontmatter,
      nodeContent('frontmatter', 'Properties', frontmatter),
    ));
  }

  for (const token of tokens) {
    if (token === rootHeading || token.type === 'space') continue;

    if (token.type === 'heading') {
      while (
        headingStack.length > 1 &&
        headingStack[headingStack.length - 1].depth >= token.depth
      ) {
        headingStack.pop();
      }
      const headingNode = createNode(
        'heading',
        token.text,
        token.raw.trim(),
        headingContent(token.text),
      );
      headingStack[headingStack.length - 1].node.children.push(headingNode);
      headingStack.push({ depth: token.depth, node: headingNode });
      continue;
    }

    if (token.type === 'paragraph') {
      const agent = parseAgentBlock(token.raw);
      if (agent) {
        const title = agent.title || agent.agentRoleName || 'AI conversation';
        attach(createNode(
          'agent',
          title,
          token.raw.trim(),
          nodeContent('agent', agent.agentType, title),
          { agent },
        ));
      } else {
        attach(createNode(
          'paragraph',
          summarize(token.text, 80) || 'Text',
          token.raw.trim(),
          nodeContent('paragraph', 'Text', token.text),
        ));
      }
      continue;
    }

    if (isListToken(token)) {
      addList(token, headingStack[headingStack.length - 1].node);
      continue;
    }

    if (token.type === 'code') {
      const language = token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() || null;
      const isMermaid = language === 'mermaid';
      const kind: MarkmapBlockKind = isMermaid ? 'mermaid' : 'code';
      const label = isMermaid ? mermaidTitle(token.text) : (language || 'Code');
      attach(createNode(
        kind,
        label,
        token.text,
        nodeContent(kind, label, isMermaid ? mermaidSummary(token.text) : token.text),
        { language },
      ));
      continue;
    }

    if (token.type === 'blockquote') {
      attach(createNode(
        'blockquote',
        summarize(token.text, 80) || 'Quote',
        token.raw.trim(),
        nodeContent('blockquote', 'Quote', token.text),
      ));
      continue;
    }

    if (isTableToken(token)) {
      const columns = token.header.map((cell) => plainText(cell.text)).filter(Boolean).join(' · ');
      attach(createNode(
        'table',
        columns || 'Table',
        token.raw.trim(),
        nodeContent('table', 'Table', columns),
      ));
      continue;
    }

    if (token.type === 'hr') {
      attach(createNode('separator', 'Separator', token.raw.trim(), nodeBadge('separator', 'Separator')));
      continue;
    }

    if (token.type === 'html') {
      const text = plainText(token.raw.replace(/<[^>]*>/g, ' '));
      attach(createNode(
        'html',
        summarize(text, 80) || 'HTML',
        token.raw.trim(),
        nodeContent('html', 'HTML', text || token.raw),
      ));
      continue;
    }

    const source = token.raw?.trim();
    if (source) {
      attach(createNode(
        'paragraph',
        summarize(source, 80) || 'Text',
        source,
        nodeContent('paragraph', 'Text', source),
      ));
    }
  }

  return { root, blocks };
}

export function hasMarkmapContent(document: MarkmapDocument): boolean {
  return Object.values(document.blocks).some((block) => !block.synthetic);
}
