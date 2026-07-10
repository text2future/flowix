import { Node as TiptapNode, mergeAttributes } from '@tiptap/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { web, type WebPageMetadata } from '@platform/tauri/client';
import { translate, type I18nKey } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    webCard: {
      insertWebCard: (url?: string) => ReturnType;
    };
  }
}

type WebCardAttrs = {
  url: string;
  title: string;
  description: string;
  image: string;
};

const DEFAULT_ATTRS: WebCardAttrs = {
  url: '',
  title: '',
  description: '',
  image: '',
};

const WEB_CARD_RE = /^::webcard\s*(\{[\s\S]*?\})(?:\n|$)/;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAttrs(attrs: Partial<WebCardAttrs> | null | undefined): WebCardAttrs {
  return {
    url: normalizeText(attrs?.url),
    title: normalizeText(attrs?.title),
    description: normalizeText(attrs?.description),
    image: normalizeText(attrs?.image),
  };
}

function normalizeUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function browserParsePage(url: string): Promise<WebPageMetadata> {
  const normalizedUrl = normalizeUrlInput(url);
  const response = await fetch(normalizedUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = (selector: string) =>
    doc.querySelector<HTMLMetaElement>(selector)?.content?.trim() ?? '';
  const image = meta('meta[property="og:image"], meta[name="twitter:image"]');
  return {
    url: response.url || normalizedUrl,
    title:
      meta('meta[property="og:title"], meta[name="twitter:title"]') ||
      doc.querySelector('title')?.textContent?.trim() ||
      normalizedUrl,
    description:
      meta('meta[property="og:description"], meta[name="twitter:description"], meta[name="description"]') ||
      '',
    image: image ? new URL(image, response.url || normalizedUrl).toString() : '',
  };
}

async function parsePage(url: string): Promise<WebPageMetadata> {
  try {
    return await web.parsePage(url);
  } catch (tauriError) {
    try {
      return await browserParsePage(url);
    } catch {
      throw tauriError;
    }
  }
}

// NodeView 不在 React 树内 ── 走 user-settings-store 读最新 AppLanguage,
// 与 agent-thread-card 的 `t(key)` 模式同源 (跨窗口同步跟 I18nProvider 一致)。
function t(key: I18nKey): string {
  const language = useUserSettingsStore.getState().settings.language;
  return translate(language, key);
}

function renderCard(card: HTMLElement, attrs: WebCardAttrs) {
  card.innerHTML = '';
  if (!attrs.url) return;

  const content = document.createElement('div');
  content.className = 'web-card-content';

  const title = document.createElement('div');
  title.className = 'web-card-title';
  title.textContent = attrs.title || attrs.url || t('editor.webCard.titleFallback');

  const description = document.createElement('div');
  description.className = 'web-card-description';
  description.textContent = attrs.description || hostnameOf(attrs.url);

  const link = document.createElement('div');
  link.className = 'web-card-link';
  link.textContent = attrs.url;

  content.append(title, description, link);
  card.append(content);

  if (attrs.image) {
    const preview = document.createElement('div');
    preview.className = 'web-card-preview';
    const img = document.createElement('img');
    img.src = attrs.image;
    img.alt = '';
    img.loading = 'lazy';
    preview.append(img);
    card.append(preview);
  }
}

export const WebCard = TiptapNode.create({
  name: 'webCard',

  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: DEFAULT_ATTRS.url,
        parseHTML: (element) => element.getAttribute('data-url') ?? DEFAULT_ATTRS.url,
        renderHTML: (attributes) => ({ 'data-url': normalizeText(attributes.url) }),
      },
      title: {
        default: DEFAULT_ATTRS.title,
        parseHTML: (element) => element.getAttribute('data-title') ?? DEFAULT_ATTRS.title,
        renderHTML: (attributes) => ({ 'data-title': normalizeText(attributes.title) }),
      },
      description: {
        default: DEFAULT_ATTRS.description,
        parseHTML: (element) => element.getAttribute('data-description') ?? DEFAULT_ATTRS.description,
        renderHTML: (attributes) => ({ 'data-description': normalizeText(attributes.description) }),
      },
      image: {
        default: DEFAULT_ATTRS.image,
        parseHTML: (element) => element.getAttribute('data-image') ?? DEFAULT_ATTRS.image,
        renderHTML: (attributes) => ({ 'data-image': normalizeText(attributes.image) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="web-card"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'web-card' })];
  },

  addCommands() {
    return {
      insertWebCard:
        (url = '') =>
        ({ state, dispatch, tr }) => {
          const nodeType = state.schema.nodes[this.name];
          if (!nodeType) return false;

          const node = nodeType.create({ ...DEFAULT_ATTRS, url: normalizeUrlInput(url) });
          tr.replaceSelectionWith(node);

          dispatch?.(tr.scrollIntoView());
          return true;
        },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let attrs = normalizeAttrs(node.attrs);
      let active = attrs.url.length === 0;
      let loading = false;
      let requestId = 0;

      const dom = document.createElement('div');
      dom.className = 'web-card-node';
      dom.dataset.type = 'web-card';

      const card = document.createElement('div');
      card.className = 'web-card';
      dom.append(card);

      const editorWrap = document.createElement('div');
      editorWrap.className = 'web-card-editor';

      const input = document.createElement('input');
      input.className = 'web-card-input';
      input.type = 'url';
      input.placeholder = t('editor.webCard.urlPlaceholder');
      input.value = attrs.url;

      const status = document.createElement('div');
      status.className = 'web-card-status';
      status.textContent = t('editor.webCard.inputHint');

      editorWrap.append(input, status);
      dom.append(editorWrap);

      const writeAttrs = (nextAttrs: WebCardAttrs) => {
        attrs = nextAttrs;
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (typeof pos === 'number') {
          editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, attrs));
        }
        input.value = attrs.url;
        renderCard(card, attrs);
      };

      const setActive = (nextActive: boolean) => {
        active = nextActive;
        dom.classList.toggle('is-active', active);
        dom.classList.toggle('has-url', Boolean(attrs.url));
        if (active) {
          window.requestAnimationFrame(() => {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          });
        }
      };

      const setLoading = (nextLoading: boolean, message: string) => {
        loading = nextLoading;
        dom.classList.toggle('is-loading', loading);
        dom.classList.toggle('has-url', Boolean(attrs.url));
        status.textContent = message;
      };

      const submit = async () => {
        const url = normalizeUrlInput(input.value);
        if (!url) {
          status.textContent = t('editor.webCard.emptyUrl');
          return;
        }

        const currentRequest = ++requestId;
        setLoading(true, t('editor.webCard.parsing'));
        try {
          const metadata = await parsePage(url);
          if (currentRequest !== requestId) return;
          writeAttrs(normalizeAttrs(metadata));
          setLoading(false, t('editor.webCard.parsed'));
          setActive(false);
        } catch {
          if (currentRequest !== requestId) return;
          writeAttrs({ ...attrs, url });
          setLoading(false, t('editor.webCard.parseFailed'));
          setActive(true);
        }
      };

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void submit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setActive(false);
        }
      });

      input.addEventListener('blur', () => {
        if (loading) return;
        const url = normalizeUrlInput(input.value);
        if (url && url !== attrs.url) {
          void submit();
          return;
        }
        if (attrs.url) setActive(false);
      });

      dom.addEventListener('mousedown', (event) => {
        if (active) return;
        event.preventDefault();
        if (attrs.url) {
          void openUrl(attrs.url).catch((error) => {
            console.warn('[web-card] Failed to open url:', error);
          });
          return;
        }
        setActive(true);
      });

      renderCard(card, attrs);
      dom.classList.toggle('has-url', Boolean(attrs.url));
      setActive(active);

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type.name !== this.name) return false;
          attrs = normalizeAttrs(updatedNode.attrs);
          input.value = attrs.url;
          renderCard(card, attrs);
          dom.classList.toggle('has-url', Boolean(attrs.url));
          return true;
        },
        stopEvent: (event) => active && editorWrap.contains(event.target as Node),
        ignoreMutation: () => true,
      };
    };
  },

  markdownTokenizer: {
    name: 'webCard',
    level: 'block' as const,
    start(src: string) {
      return src.indexOf('::webcard');
    },
    tokenize(src: string) {
      const match = WEB_CARD_RE.exec(src);
      if (!match) return undefined;
      return {
        type: 'webCard',
        raw: match[0],
        text: match[1],
      };
    },
  },

  parseMarkdown(token: any) {
    try {
      return {
        type: 'webCard',
        attrs: normalizeAttrs(JSON.parse(token.text)),
      };
    } catch {
      return {
        type: 'webCard',
        attrs: DEFAULT_ATTRS,
      };
    }
  },

  renderMarkdown(node: any) {
    const attrs = normalizeAttrs(node.attrs);
    return `::webcard${JSON.stringify(attrs, null, 2)}`;
  },
});
