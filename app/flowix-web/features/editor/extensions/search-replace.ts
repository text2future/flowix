/* eslint-disable @typescript-eslint/no-explicit-any */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Range } from '@tiptap/core';

export interface SearchAndReplaceStorage {
  searchTerm: string;
  replaceTerm: string;
  results: Range[];
  resultIndex: number;
  isActive: boolean;
}

export interface SearchAndReplaceOptions {
  searchResultClass: string;
  disableRegex: boolean;
}

const defaultOptions: SearchAndReplaceOptions = {
  searchResultClass: 'search-result',
  disableRegex: true,
};

export const searchAndReplacePluginKey = new PluginKey('searchAndReplace');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getRegex(searchTerm: string, disableRegex: boolean): RegExp | null {
  if (!searchTerm) return null;
  const pattern = disableRegex ? escapeRegExp(searchTerm) : searchTerm;
  return new RegExp(pattern, 'gui');
}

interface ProcessedSearches {
  decorations: DecorationSet;
  results: Range[];
}

function processSearches(
  doc: any,
  searchTerm: string,
  searchResultClass: string,
  resultIndex: number,
  disableRegex: boolean,
): ProcessedSearches {
  const regex = getRegex(searchTerm, disableRegex);
  if (!regex) {
    return { decorations: DecorationSet.empty, results: [] };
  }

  const decorations: Decoration[] = [];
  const results: Range[] = [];

  doc.descendants((node: any, pos: number) => {
    if (!node.isText || !node.text) return true;

    const text = node.text;
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
      const from = pos + match.index;
      const to = from + match[0].length;
      results.push({ from, to });

      const isCurrent = results.length - 1 === resultIndex;
      const className = isCurrent
        ? `${searchResultClass} ${searchResultClass}-current`
        : searchResultClass;
      decorations.push(Decoration.inline(from, to, { class: className }));

      if (match[0].length === 0) {
        regex.lastIndex++;
      }
    }

    return true;
  });

  return {
    decorations: DecorationSet.create(doc, decorations),
    results,
  };
}

function rebaseNextResult(
  replaceTerm: string,
  index: number,
  lastOffset: number,
  results: Range[],
): [number, Range[]] | null {
  const nextIndex = index + 1;
  if (!results[nextIndex]) return null;

  const { from: currentFrom, to: currentTo } = results[index];
  const offset = currentTo - currentFrom - replaceTerm.length + lastOffset;

  const { from, to } = results[nextIndex];
  results[nextIndex] = {
    to: to - offset,
    from: from - offset,
  };

  return [offset, results];
}

declare module '@tiptap/core' {
  interface Storage {
    searchAndReplace: SearchAndReplaceStorage;
  }

  interface Commands<ReturnType> {
    searchAndReplace: {
      openSearch: () => ReturnType;
      closeSearch: () => ReturnType;
      setSearchTerm: (searchTerm: string) => ReturnType;
      setReplaceTerm: (replaceTerm: string) => ReturnType;
      nextSearchResult: () => ReturnType;
      previousSearchResult: () => ReturnType;
      replace: () => ReturnType;
      replaceAll: () => ReturnType;
    };
  }
}

export const SearchAndReplace = Extension.create<SearchAndReplaceOptions>({
  name: 'searchAndReplace',

  addOptions() {
    return { ...defaultOptions };
  },

  addStorage() {
    return {
      searchTerm: '',
      replaceTerm: '',
      results: [] as Range[],
      resultIndex: 0,
      isActive: false,
    };
  },

  addProseMirrorPlugins() {
    const { searchResultClass, disableRegex } = this.options;

    return [
      new Plugin({
        key: searchAndReplacePluginKey,

        state: {
          init: (_, state) => {
            const { decorations, results } = processSearches(
              state.doc,
              '',
              searchResultClass,
              0,
              disableRegex,
            );
            return { decorations, results };
          },

          apply: (tr, value, _, newState) => {
            const storage = (this as any).editor.storage.searchAndReplace;
            const searchTerm = storage.searchTerm;
            const resultIndex = storage.resultIndex;

            const meta = tr.getMeta(searchAndReplacePluginKey);

            if (meta?.searchTerm !== undefined) {
              const { decorations, results } = processSearches(
                newState.doc,
                meta.searchTerm,
                searchResultClass,
                resultIndex,
                disableRegex,
              );
              storage.results = results;
              storage.resultIndex = results.length > 0 ? 0 : 0;
              return { decorations, results };
            }

            if (meta?.resultIndex !== undefined) {
              const { decorations } = processSearches(
                newState.doc,
                searchTerm,
                searchResultClass,
                meta.resultIndex,
                disableRegex,
              );
              return { decorations, results: storage.results };
            }

            if (tr.docChanged) {
              const { decorations, results } = processSearches(
                newState.doc,
                searchTerm,
                searchResultClass,
                resultIndex,
                disableRegex,
              );
              return { decorations, results };
            }

            return value;
          },
        },

        props: {
          decorations(state) {
            return (this as any).getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setSearchTerm: (searchTerm: string) => ({ editor, tr }: any) => {
        editor.storage.searchAndReplace.searchTerm = searchTerm;
        editor.storage.searchAndReplace.resultIndex = 0;
        tr.setMeta(searchAndReplacePluginKey, { searchTerm });
        return true;
      },

      setReplaceTerm: (replaceTerm: string) => ({ editor }: any) => {
        editor.storage.searchAndReplace.replaceTerm = replaceTerm;
        return true;
      },

      toggleSearch: () => ({ editor }: any) => {
        editor.storage.searchAndReplace.isActive = !editor.storage.searchAndReplace.isActive;
        return true;
      },

      openSearch: () => ({ editor }: any) => {
        editor.storage.searchAndReplace.isActive = true;
        return true;
      },

      closeSearch: () => ({ editor, tr }: any) => {
        editor.storage.searchAndReplace.isActive = false;
        editor.storage.searchAndReplace.searchTerm = '';
        editor.storage.searchAndReplace.results = [];
        tr.setMeta(searchAndReplacePluginKey, { searchTerm: '' });
        return true;
      },

      nextSearchResult: () => ({ editor, tr }: any) => {
        const storage = editor.storage.searchAndReplace;
        if (storage.results.length === 0) return true;
        storage.resultIndex = (storage.resultIndex + 1) % storage.results.length;
        tr.setMeta(searchAndReplacePluginKey, { resultIndex: storage.resultIndex });
        return true;
      },

      previousSearchResult: () => ({ editor, tr }: any) => {
        const storage = editor.storage.searchAndReplace;
        if (storage.results.length === 0) return true;
        storage.resultIndex =
          (storage.resultIndex - 1 + storage.results.length) % storage.results.length;
        tr.setMeta(searchAndReplacePluginKey, { resultIndex: storage.resultIndex });
        return true;
      },

      replace: () => ({ editor, state, dispatch }: any) => {
        const storage = editor.storage.searchAndReplace;
        if (storage.results.length === 0) return false;
        const { from, to } = storage.results[0];
        const replaceTerm = storage.replaceTerm;
        dispatch(state.tr.insertText(replaceTerm, from, to));
        return true;
      },

      replaceAll: () => ({ editor, tr, dispatch }: any) => {
        const storage = editor.storage.searchAndReplace;
        if (storage.results.length === 0) return false;
        let offset = 0;
        const resultsCopy = storage.results.slice();
        const replaceTerm = storage.replaceTerm;

        for (let i = 0; i < resultsCopy.length; i++) {
          const { from, to } = resultsCopy[i];
          tr.insertText(replaceTerm, from, to);
          const rebaseResponse = rebaseNextResult(replaceTerm, i, offset, resultsCopy);
          if (!rebaseResponse) continue;
          offset = rebaseResponse[0];
        }
        dispatch(tr);
        return true;
      },
    } as any;
  },

  addKeyboardShortcuts() {
    const { editor } = this;

    return {
      'Mod-f': () => {
        editor.commands.openSearch();
        return true;
      },
      Escape: () => {
        if (editor.storage.searchAndReplace.isActive) {
          editor.commands.closeSearch();
          return true;
        }
        return false;
      },
    };
  },
});
