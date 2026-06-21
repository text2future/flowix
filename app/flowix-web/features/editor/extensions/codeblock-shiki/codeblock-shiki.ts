import { CodeBlock } from '@tiptap/extension-code-block';
import { createCodeBlockShikiView } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki-view';
import { proseMirrorPluginShiki } from '@features/editor/extensions/codeblock-shiki/shiki/shiki-plugin';

const defaultTheme = 'github-light'
const defaultLanguage = 'plaintext'
const languageClassPrefix = 'language-'

/** Shiki 主题白名单 — 与 constants.ts 中 4 套 *_VARS 的 --shiki-theme 一一对应。
 *  这里预加载全部 4 个, 切换主题时 getDecorations() 同步可用, 无 async lag / 无 flash。
 *  4 × ~10KB JSON 远小于语言 grammar 的体量, 不构成性能负担。 */
const PRELOADED_SHIKI_THEMES = [
  'github-light',
  'github-dark',
  'one-light',
  'catppuccin-latte',
] as const;

function getLanguageFromElement(element: HTMLElement): string | null {
  const codeElement = element.matches('code') ? element : element.querySelector('code');
  const languageClass = Array.from(codeElement?.classList || [])
    .find(className => className.startsWith(languageClassPrefix));

  return languageClass?.replace(languageClassPrefix, '') || null;
}

export const CodeBlockShiki = CodeBlock.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      defaultLanguage,
      defaultTheme,
    } as any;
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: defaultLanguage,
        parseHTML: (element) => {
          return element.getAttribute('data-language') || getLanguageFromElement(element) || null;
        },
        renderHTML: (attributes) => {
          if (attributes.language === defaultLanguage) return {};
          return { 'data-language': attributes.language };
        },
      },
      theme: {
        default: defaultTheme,
        parseHTML: element => element.getAttribute('data-theme'),
      },
    };
  },

  addNodeView() {
    return (...args) => createCodeBlockShikiView(...args);
  },

  addProseMirrorPlugins() {
    const plugins = super.addProseMirrorPlugins?.() || [];
    return [
      ...plugins,
      proseMirrorPluginShiki({
        name: this.name,
        defaultLanguage,
        defaultTheme,
        preloadThemes: [...PRELOADED_SHIKI_THEMES],
      }),
    ];
  },
});
