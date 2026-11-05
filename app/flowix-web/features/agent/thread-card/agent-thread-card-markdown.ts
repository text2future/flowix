import { Marked } from "marked";
import { createLogger } from "@/lib/logger";
import { literalUnderscoreTokenizer } from "@/lib/markdown-literal-underscore";
import { normalizeAgentTypeKey } from "@/lib/agent-types";
import { sanitizeLinkHref } from "@/lib/safe-link";
import type { AgentThreadCardInputAttachment } from "@features/agent/thread-card/composer/composer-attachment-types";
import {
  LEGACY_THREAD_CARD_IMAGES_ATTRIBUTE,
  THREAD_CARD_ATTACHMENTS_ATTRIBUTE,
} from "@features/agent/thread-card/composer/composer-attachment-compat";
import {
  getShiki,
  loadHighlighter,
  loadLanguage,
} from "@features/editor/extensions/codeblock-shiki/shiki/shiki-highlighter";
import { getShikiLanguageDefinition } from "@features/editor/extensions/codeblock-shiki/shiki/shiki-languages";
import { getTokenStyle } from "@features/editor/extensions/codeblock-shiki/shiki/shiki-decorations";

export const DEFAULT_AGENT_THREAD_CARD_TITLE = "";
export const AGENT_THREAD_CARD_MESSAGE_CODE_BLOCK_CLASS =
  "agent-thread-card__message-code-block";
export const FLOWIX_AGENT_THREAD_CARD_METADATA_VERSION = 1;
export const FLOWIX_AGENT_THREAD_CARD_MARKER = "flowix:agent-thread-card";

interface FlowixAgentThreadCardMetadata {
  version: number;
  instanceId: string;
  threadId: string;
  agentType: string;
  collapsed: boolean;
  fullscreen: boolean;
  inputDraft: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse the versioned node metadata comment used for persisted Thread Cards.
 * The trailing line break belongs to the metadata so the comment cannot be
 * turned into an empty paragraph by the Markdown parser.
 */
export function parseFlowixAgentThreadCardComment(source: string): {
  raw: string;
  metadata: Record<string, unknown>;
} | null {
  const match = new RegExp(
    `^<!--[ \\t]*${FLOWIX_AGENT_THREAD_CARD_MARKER}[ \\t]+(\\{[^\\r\\n]*\\})[ \\t]*-->(?:\\r?\\n|$)`,
  ).exec(source);
  if (!match) return null;

  try {
    const metadata = JSON.parse(match[1]) as unknown;
    if (!isRecord(metadata)) return null;
    if (metadata.version !== FLOWIX_AGENT_THREAD_CARD_METADATA_VERSION) {
      return null;
    }
    return { raw: match[0], metadata };
  } catch {
    return null;
  }
}

const AGENT_SHIKI_THEME_DATASET = "agentShikiTheme";
const AGENT_THEME_CHANGE_EVENT = "app-theme-changed";
const logger = createLogger("agent-code-highlight");

function getAgentCodeBlockLanguage(code: Element): {
  language: string;
  label: string;
} {
  const languageClass = Array.from(code.classList).find((className) =>
    className.startsWith("language-"),
  );
  const rawLanguage = languageClass?.slice("language-".length) ?? "";
  const definition = getShikiLanguageDefinition(rawLanguage);
  const isPlaintext = ["", "plaintext", "text"].includes(
    rawLanguage.toLowerCase(),
  );

  return {
    language: definition?.id ?? "plaintext",
    label: definition?.label ?? (isPlaintext ? "Text" : rawLanguage),
  };
}

/** Add the small, non-interactive language label shown in the code block corner. */
export function prepareAgentThreadCardCodeBlockLabels(root: ParentNode): void {
  root
    .querySelectorAll<HTMLElement>(
      `pre.${AGENT_THREAD_CARD_MESSAGE_CODE_BLOCK_CLASS} > code`,
    )
    .forEach((code) => {
      const pre = code.parentElement;
      if (!pre) return;
      pre.dataset.languageLabel = getAgentCodeBlockLanguage(code).label;
    });
}

function readAgentShikiTheme(): string {
  const theme = getComputedStyle(document.documentElement)
    .getPropertyValue("--shiki-theme")
    .trim();
  return theme || "github-light";
}

function appendAgentShikiTokens(
  code: HTMLElement,
  lines: readonly (readonly {
    content: string;
    color?: string;
    bgColor?: string;
    fontStyle?: number;
  }[])[],
): void {
  const fragment = document.createDocumentFragment();

  lines.forEach((line, lineIndex) => {
    line.forEach((token) => {
      if (!token.content) return;
      const style = getTokenStyle(token);
      if (!style) {
        fragment.append(document.createTextNode(token.content));
        return;
      }
      const span = document.createElement("span");
      // Tauri adds a style-src nonce in production, blocking style attributes.
      // Apply generated token styles through CSSOM so the colors remain visible.
      span.style.cssText = style;
      span.textContent = token.content;
      fragment.append(span);
    });
    if (lineIndex < lines.length - 1) fragment.append(document.createTextNode("\n"));
  });

  code.replaceChildren(fragment);
}

/** Highlight completed Agent code blocks and refresh them when the app theme changes. */
export async function highlightAgentThreadCardCodeBlocks(
  container: ParentNode,
): Promise<void> {
  const codeBlocks = Array.from(
    container.querySelectorAll<HTMLElement>(
      `pre.${AGENT_THREAD_CARD_MESSAGE_CODE_BLOCK_CLASS} > code`,
    ),
  );
  if (!codeBlocks.length) return;

  try {
    await loadHighlighter();
  } catch (error) {
    logger.warn("Shiki initialization failed", { error });
    return;
  }

  const highlighter = getShiki();
  if (!highlighter) {
    logger.warn("Shiki initialization completed without a highlighter");
    return;
  }

  const requestedTheme = readAgentShikiTheme();
  const theme = highlighter.getLoadedThemes().includes(requestedTheme)
    ? requestedTheme
    : highlighter.getLoadedThemes()[0];
  if (!theme) return;

  await Promise.all(codeBlocks.map(async (code) => {
    const pre = code.parentElement;
    if (!pre) return;

    const source = code.textContent ?? "";
    if (pre.dataset[AGENT_SHIKI_THEME_DATASET] === theme) return;

    const { language } = getAgentCodeBlockLanguage(code);

    if (language !== "plaintext") {
      try {
        await loadLanguage(language);
      } catch (error) {
        logger.warn("Shiki language load failed", { language, error });
        return;
      }
    }

    // Theme may have changed while the language grammar was loading. Let the
    // theme-change pass handle this block with the newer theme instead.
    if (readAgentShikiTheme() !== theme) return;
    // The message list may still be detached while history/progressive
    // rendering is constructing it. Requiring `code.isConnected` drops the
    // highlight result in that window and there is no later retry. Keep the
    // ownership check scoped to the current message container instead: this
    // still rejects a removed/replaced code block, while allowing Shiki to
    // decorate a detached subtree before it is mounted.
    if (!container.contains(code) || code.textContent !== source) return;

    try {
      const lines = highlighter.codeToTokensBase(source, { lang: language, theme });
      appendAgentShikiTokens(code, lines);
      pre.dataset[AGENT_SHIKI_THEME_DATASET] = theme;
    } catch (error) {
      logger.warn("Shiki tokenization failed", { language, theme, error });
      // Unsupported or malformed languages remain as the original plain code.
    }
  }));
}

if (typeof window !== "undefined") {
  window.addEventListener(AGENT_THEME_CHANGE_EVENT, () => {
    void highlightAgentThreadCardCodeBlocks(document);
  });
}

function unescapeAgentThreadCardAttr(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export function parseAgentThreadCardAttrs(
  rawAttrs: string,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /(\w+)="((?:\\"|\\\\|[^"])*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attrRe.exec(rawAttrs))) {
    attrs[match[1]] = unescapeAgentThreadCardAttr(match[2]);
  }

  return attrs;
}

export function decodeAgentThreadCardInputDraft(
  value: string | null | undefined,
): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function encodeAgentThreadCardInputAttachments(
  attachments: AgentThreadCardInputAttachment[] | null | undefined,
): string {
  return encodeURIComponent(JSON.stringify(attachments ?? []));
}

export function decodeAgentThreadCardInputAttachments(
  value: string | null | undefined,
): AgentThreadCardInputAttachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (attachment): attachment is AgentThreadCardInputAttachment =>
        !!attachment &&
        typeof attachment.path === "string" &&
        typeof attachment.mimeType === "string" &&
        typeof attachment.name === "string",
    );
  } catch {
    return [];
  }
}

function parseAgentThreadCardInputAttachments(value: unknown): AgentThreadCardInputAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (attachment): attachment is AgentThreadCardInputAttachment =>
      !!attachment &&
      typeof attachment.path === "string" &&
      typeof attachment.mimeType === "string" &&
      typeof attachment.name === "string",
  );
}

function parseAgentThreadCardNodeAttrs(
  values: Record<string, unknown>,
  inputDraftEncoded: boolean,
): Record<string, unknown> {
  const stringValue = (value: unknown): string =>
    typeof value === "string" ? value : "";
  const inputDraftValue = stringValue(values.inputDraft);
  const attachmentValue = values[THREAD_CARD_ATTACHMENTS_ATTRIBUTE]
    ?? values[LEGACY_THREAD_CARD_IMAGES_ATTRIBUTE];

  return {
    threadId: stringValue(values.threadId) || null,
    instanceId: stringValue(values.instanceId) || null,
    title: stringValue(values.title) || DEFAULT_AGENT_THREAD_CARD_TITLE,
    typeKey: normalizeAgentTypeKey(
      typeof values.agentType === "string" ? values.agentType : undefined,
    ),
    collapsed: values.collapsed === true || values.collapsed === "true",
    fullscreen: values.fullscreen === true || values.fullscreen === "true",
    inputDraft: inputDraftValue
      ? inputDraftEncoded
        ? decodeAgentThreadCardInputDraft(inputDraftValue)
        : inputDraftValue
      : null,
    [THREAD_CARD_ATTACHMENTS_ATTRIBUTE]: inputDraftEncoded
      ? decodeAgentThreadCardInputAttachments(
        typeof attachmentValue === "string" ? attachmentValue : undefined,
      )
      : parseAgentThreadCardInputAttachments(attachmentValue),
  };
}

type KatexModule = typeof import("katex");

const AGENT_MATH_SELECTOR = ".agent-thread-card__math[data-latex]";
const BLOCK_MATH_RE =
  /^ {0,3}(?:\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$)/;
const BLOCK_MATH_START_RE = /^ {0,3}(?:\\\[|\$\$)/m;
const INLINE_MATH_RE = /^\\\(([\s\S]*?)\\\)/;
const CJK_STRONG_BOUNDARY_RE =
  /^\*\*(?!\*)((?:(?!\*\*)[\s\S])+?)\*\*(?=\p{Script=Han})/u;
const mathCopyContainers = new WeakSet<HTMLElement>();
let katexPromise: Promise<KatexModule> | null = null;
let katexLoaded: KatexModule | null = null;

function escapeAgentThreadCardHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAgentThreadCardHtmlAttr(value: string): string {
  return escapeAgentThreadCardHtml(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSafeAgentAnchor(rawTag: string): string | null {
  const match = /^<a\b([^>]*)>$/i.exec(rawTag.trim());
  if (match) {
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
      match[1],
    );
    const rawHref = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3];
    if (!rawHref) {
      return null;
    }
    // Decode HTML entities before the protocol allowlist check. Otherwise an
    // href such as `javascript&#x3A;alert(1)` can pass a literal-prefix test.
    const template = document.createElement("template");
    template.innerHTML = rawTag.trim();
    const href = template.content.firstElementChild?.getAttribute("href");
    const safeHref = sanitizeLinkHref(href);
    if (!safeHref) return null;
    return `<a href="${escapeAgentThreadCardHtmlAttr(safeHref)}">`;
  }
  if (/^<\/a>$/i.test(rawTag.trim())) return "</a>";
  return null;
}

function safeAgentImageHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href || /[\u0000-\u001f\u007f]/u.test(href)) return null;
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(href)) return href;
  // Remote images need an explicit web protocol. Keep relative and root paths
  // for existing local Markdown references, while rejecting executable and
  // otherwise unexpected URI schemes.
  if (/^https?:\/\//i.test(href) || href.startsWith("//")) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return sanitizeLinkHref(href);
  return href;
}

function ensureAgentThreadCardKatex(): Promise<KatexModule> {
  if (katexLoaded) return Promise.resolve(katexLoaded);
  if (!katexPromise) {
    katexPromise = Promise.all([
      import("katex"),
      import("katex/dist/katex.min.css"),
    ])
      .then(([module]) => {
        katexLoaded = module;
        return module;
      })
      .catch((error) => {
        katexPromise = null;
        throw error;
      });
  }
  return katexPromise;
}

function renderAgentMathHtml(latex: string, displayMode: boolean): string {
  const normalizedLatex = latex.trim();
  const className = displayMode
    ? "agent-thread-card__math agent-thread-card__math--block"
    : "agent-thread-card__math agent-thread-card__math--inline";
  const attrLatex = escapeAgentThreadCardHtmlAttr(normalizedLatex);
  const escapedLatex = escapeAgentThreadCardHtml(normalizedLatex);
  const content = displayMode
    ? `<span class="agent-thread-card__math-scroller">${escapedLatex}</span>`
    : escapedLatex;

  return `<span class="${className}" data-latex="${attrLatex}" data-display-mode="${displayMode ? "block" : "inline"}" role="button" tabindex="0">${content}</span>`;
}

/**
 * 行为约束：
 * - 数学语法必须由 Marked tokenizer 识别，让 Markdown lexer 统一处理代码、链接和转义边界。
 * - tokenizer 只消费到公式结束符，结束符后的 Markdown 必须继续参与解析。
 * - data-latex 始终保存原始公式；KaTeX 只替换展示内容，复制功能不得依赖渲染后的 DOM。
 */
const cardMarked = new Marked({
  async: false,
  gfm: true,
  breaks: true,
  // Agent messages can contain arbitrary user/assistant text. Keep Markdown
  // formatting, but render raw HTML as text instead of handing it to
  // `template.innerHTML` as executable/interactive markup.
  renderer: {
    html({ text }: { text: string }) {
      const safeAnchor = renderSafeAgentAnchor(text);
      if (safeAnchor) return safeAnchor;
      return escapeAgentThreadCardHtml(text);
    },
    image({ href, title, text }) {
      const safeHref = safeAgentImageHref(href);
      if (!safeHref) return escapeAgentThreadCardHtml(text || href);
      const titleAttribute = title
        ? ` title="${escapeAgentThreadCardHtmlAttr(title)}"`
        : "";
      return `<img width="120" height="120" src="${escapeAgentThreadCardHtmlAttr(safeHref)}" alt="${escapeAgentThreadCardHtmlAttr(text)}"${titleAttribute} data-agent-image-preview tabindex="0" role="button" aria-haspopup="dialog" aria-label="Preview image: ${escapeAgentThreadCardHtmlAttr(text || title || "image")}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    },
    link({ href, title, tokens }) {
      // Markdown 链接此前走 marked 默认渲染器：href 原样进入 DOM，只靠点击处理
      // （link-navigation → sanitizeLinkHref）在打开时才拦截。这里补上 DOM 层护栏，
      // 让 javascript:/data: 这类协议根本不落地。点击处理只认 `a[href]`，
      // 因此被拦下的链接自然退化为不可点击文本。
      const text = this.parser.parseInline(tokens);
      const titleAttribute = title
        ? ` title="${escapeAgentThreadCardHtmlAttr(title)}"`
        : "";
      const safeHref = sanitizeLinkHref(href);
      if (!safeHref) return `<a${titleAttribute} data-unsafe-href="true">${text}</a>`;
      return `<a href="${escapeAgentThreadCardHtmlAttr(safeHref)}"${titleAttribute}>${text}</a>`;
    },
  },
});

cardMarked.use({
  extensions: [
    {
      // Same policy as the note editor and export renderer: `__text__` is a
      // literal identifier (`__pycache__`, `__init__.py`), never bold. The
      // tokenizer emits a plain `text` token, so it carries no child tokens.
      ...literalUnderscoreTokenizer,
    },
    {
      name: "agentCjkStrong",
      level: "inline",
      start(src) {
        const index = src.indexOf("**");
        return index >= 0 ? index : undefined;
      },
      tokenizer(src) {
        // CommonMark treats punctuation before a closing delimiter followed
        // by CJK text as non-closing. Accept that boundary for agent output.
        const match = CJK_STRONG_BOUNDARY_RE.exec(src);
        if (!match || /^\s|\s$/.test(match[1]) || !/\p{P}$/u.test(match[1])) {
          return;
        }
        return {
          type: "agentCjkStrong",
          raw: match[0],
          tokens: this.lexer.inlineTokens(match[1]),
        };
      },
      renderer(token) {
        return `<strong>${this.parser.parseInline(token.tokens ?? [])}</strong>`;
      },
      childTokens: ["tokens"],
    },
    {
      name: "agentMathBlock",
      level: "block",
      start(src) {
        return BLOCK_MATH_START_RE.exec(src)?.index;
      },
      tokenizer(src) {
        const match = BLOCK_MATH_RE.exec(src);
        if (!match) return;
        return {
          type: "agentMathBlock",
          raw: match[0],
          text: match[1] ?? match[2] ?? "",
        };
      },
      renderer(token) {
        return `${renderAgentMathHtml(token.text, true)}\n`;
      },
    },
    {
      name: "agentMathInline",
      level: "inline",
      start(src) {
        const index = src.indexOf("\\(");
        return index >= 0 ? index : undefined;
      },
      tokenizer(src) {
        const match = INLINE_MATH_RE.exec(src);
        if (!match) return;
        return {
          type: "agentMathInline",
          raw: match[0],
          text: match[1],
        };
      },
      renderer(token) {
        return renderAgentMathHtml(token.text, false);
      },
    },
  ],
});

function splitPipeTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of trimmed) {
    if (character === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  cells.push(cell.trim());

  if (trimmed.startsWith("|") && cells[0] === "") cells.shift();
  if (trimmed.endsWith("|") && cells[cells.length - 1] === "") cells.pop();
  return cells.length > 1 ? cells : null;
}

function isPipeTableSeparator(line: string): boolean {
  const cells = splitPipeTableRow(line);
  return !!cells?.length && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/**
 * Normalize Markdown for every Agent message role. Join blank-separated GFM
 * table rows, and demote Setext headings so `xxx\n---` becomes text plus a
 * horizontal rule. Fenced code is left untouched.
 */
function normalizeAgentThreadCardMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let inFence = false;
  let fenceCharacter = "";

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (inFence) {
      output.push(line);
      if (fence && fence[1][0] === fenceCharacter) inFence = false;
      index += 1;
      continue;
    }
    if (fence) {
      inFence = true;
      fenceCharacter = fence[1][0];
      output.push(line);
      index += 1;
      continue;
    }

    if (
      /^ {0,3}(?:-{1,}|={1,})[ \t]*$/.test(line) &&
      output.length > 0 &&
      output[output.length - 1].trim()
    ) {
      if (/^ {0,3}-{3,}[ \t]*$/.test(line)) {
        output.push("", line);
      } else {
        const indent = line.match(/^ */)?.[0] ?? "";
        output.push(`${indent}\\${line.trim()}`);
      }
      index += 1;
      continue;
    }

    const headerCells = splitPipeTableRow(line);
    if (headerCells) {
      let separatorIndex = index + 1;
      while (separatorIndex < lines.length && !lines[separatorIndex].trim()) {
        separatorIndex += 1;
      }
      const separatorLine = lines[separatorIndex] ?? "";
      const separatorCells = splitPipeTableRow(separatorLine);
      if (
        separatorCells &&
        isPipeTableSeparator(separatorLine) &&
        separatorCells.length === headerCells.length
      ) {
        output.push(line, separatorLine);
        let rowIndex = separatorIndex + 1;
        while (rowIndex < lines.length) {
          let nextRowIndex = rowIndex;
          while (nextRowIndex < lines.length && !lines[nextRowIndex].trim()) {
            nextRowIndex += 1;
          }
          const rowCells = splitPipeTableRow(lines[nextRowIndex] ?? "");
          if (!rowCells) {
            output.push(...lines.slice(rowIndex, nextRowIndex));
            index = nextRowIndex;
            break;
          }
          output.push(lines[nextRowIndex]);
          rowIndex = nextRowIndex + 1;
          index = rowIndex;
        }
        if (rowIndex >= lines.length) index = rowIndex;
        continue;
      }
    }

    output.push(line);
    index += 1;
  }

  return output.join("\n");
}

export function renderAgentThreadCardMarkdownToHtml(content: string): string {
  if (!content || !content.trim()) return "";
  const normalizedContent = normalizeAgentThreadCardMarkdown(content);
  const html = cardMarked.parse(normalizedContent) as string;
  // A Thread Card is a ProseMirror NodeView and therefore lives below the
  // editor's `.tiptap` element. Mark fenced blocks so editor-wide `pre`
  // selectors can explicitly leave agent message content alone.
  return html.replace(
    /<pre><code(?=[ >])/g,
    `<pre class="${AGENT_THREAD_CARD_MESSAGE_CODE_BLOCK_CLASS}"><code`,
  );
}

function findAgentMathElement(
  container: HTMLElement,
  target: EventTarget | null,
): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const math = target.closest<HTMLElement>(AGENT_MATH_SELECTOR);
  return math && container.contains(math) ? math : null;
}

async function copyAgentMath(math: HTMLElement): Promise<void> {
  const latex = math.dataset.latex;
  if (!latex || !navigator.clipboard?.writeText) return;

  try {
    await navigator.clipboard.writeText(latex);
    math.classList.add("agent-thread-card__math--copied");
    window.setTimeout(() => {
      math.classList.remove("agent-thread-card__math--copied");
    }, 700);
  } catch {
    // Clipboard access is optional in browser previews and may be denied.
  }
}

export function attachAgentThreadCardMathCopyHandlers(container: HTMLElement): void {
  if (mathCopyContainers.has(container)) return;
  mathCopyContainers.add(container);

  container.addEventListener("click", (event) => {
    const math = findAgentMathElement(container, event.target);
    if (!math) return;
    event.stopPropagation();
    void copyAgentMath(math);
  });

  container.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const math = findAgentMathElement(container, event.target);
    if (!math) return;
    event.preventDefault();
    event.stopPropagation();
    void copyAgentMath(math);
  });
}

async function renderAgentThreadCardMathNodes(
  mathNodes: HTMLElement[],
): Promise<void> {
  if (!mathNodes.length) return;

  let katex: KatexModule;
  try {
    katex = await ensureAgentThreadCardKatex();
  } catch {
    return;
  }

  mathNodes.forEach((math) => {
    const latex = math.dataset.latex;
    if (!latex || math.dataset.katexRendered === "true") return;
    const renderTarget =
      math.querySelector<HTMLElement>(".agent-thread-card__math-scroller") ??
      math;

    try {
      katex.render(latex, renderTarget, {
        displayMode: math.dataset.displayMode === "block",
        throwOnError: false,
        strict: false,
      });
      math.dataset.katexRendered = "true";
    } catch {
      renderTarget.textContent = latex;
    }
  });
}

/**
 * 对 `root`(DocumentFragment 或已挂载容器)内的 math 节点设无障碍标签并触发
 * KaTeX 渲染。KaTeX 跳过 `data-katex-rendered === "true"` 的节点 ── 增量 DOM
 * 注入下 finalized 区的 math 节点持久存在, 每条公式只在定型 append 那帧
 * 渲染一次, 不再每帧重渲染。
 *
 * 事件委托(click / keydown 复制 LaTeX)挂在稳定的 content 容器上, 由
 * [`attachAgentThreadCardMathCopyHandlers`] 一次性绑定; 新注入 fragment 内
 * 的 math 点击靠冒泡到容器, 无需重复绑定。
 */
export function prepareAgentThreadCardMath(
  root: ParentNode,
  mathCopyLabel: string,
): void {
  const mathNodes = Array.from(
    root.querySelectorAll<HTMLElement>(AGENT_MATH_SELECTOR),
  );
  mathNodes.forEach((math) => {
    math.setAttribute("aria-label", mathCopyLabel);
    math.title = mathCopyLabel;
  });
  void renderAgentThreadCardMathNodes(mathNodes);
}

export function fillWithAgentThreadCardMarkdownHtml(
  container: HTMLElement,
  html: string,
  mathCopyLabel = "Copy LaTeX",
): void {
  container.replaceChildren();
  if (!html) return;

  const template = document.createElement("template");
  template.innerHTML = html;
  container.append(template.content.cloneNode(true));
  prepareAgentThreadCardCodeBlockLabels(container);
  attachAgentThreadCardMathCopyHandlers(container);
  prepareAgentThreadCardMath(container, mathCopyLabel);
}

export function parseAgentThreadCardMarkdown(token: unknown) {
  const tokenRecord = isRecord(token) ? token : {};
  const rawAttrs = typeof tokenRecord.attrs === "string" ? tokenRecord.attrs : "";
  const comment = parseFlowixAgentThreadCardComment(
    typeof tokenRecord.metadata === "string"
      ? tokenRecord.metadata
      : rawAttrs || (typeof tokenRecord.raw === "string" ? tokenRecord.raw : ""),
  );
  const metadata = isRecord(tokenRecord.metadata)
    ? tokenRecord.metadata
    : comment?.metadata;
  if (metadata) {
    return {
      type: "agentThreadCard",
      attrs: parseAgentThreadCardNodeAttrs(metadata, false),
    };
  }

  const attrs = parseAgentThreadCardAttrs(rawAttrs);
  return {
    type: "agentThreadCard",
    attrs: parseAgentThreadCardNodeAttrs(attrs, true),
  };
}

export function renderAgentThreadCardMarkdown(node: {
  attrs?: Record<string, unknown>;
}): string {
  const stringValue = (value: unknown): string =>
    typeof value === "string" ? value : "";
  const metadata: FlowixAgentThreadCardMetadata & Record<string, unknown> = {
    version: FLOWIX_AGENT_THREAD_CARD_METADATA_VERSION,
    instanceId: stringValue(node.attrs?.instanceId),
    threadId: stringValue(node.attrs?.threadId),
    agentType: normalizeAgentTypeKey(
      typeof node.attrs?.typeKey === "string" ? node.attrs.typeKey : undefined,
    ),
    collapsed: !!node.attrs?.collapsed,
    fullscreen: !!node.attrs?.fullscreen,
    inputDraft: stringValue(node.attrs?.inputDraft),
  };
  // Keep writing the established metadata key for older Flowix versions;
  // parsed editor attributes and application code use `inputAttachments`.
  metadata[LEGACY_THREAD_CARD_IMAGES_ATTRIBUTE] = parseAgentThreadCardInputAttachments(
    node.attrs?.[THREAD_CARD_ATTACHMENTS_ATTRIBUTE],
  );
  return `<!-- ${FLOWIX_AGENT_THREAD_CARD_MARKER} ${JSON.stringify(metadata)} -->\n`;
}
