import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { createRoot, type Root } from 'react-dom/client';
import { MentionNoteDropdown } from '../../components/mention-note-dropdown';
import {
  loadMentionNotes,
  queryMentionNotes,
  toNoteReferenceAttrs,
  type MentionNoteItem,
} from './mention-note-data';

const PAGE_SIZE = 20;
const MENU_WIDTH = 320;
const MENU_MAX_HEIGHT = 288;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;

export const mentionNotePluginKey = new PluginKey('mentionNote');

interface MentionMenuState {
  triggerFrom: number;
  query: string;
  requestId: number;
}

interface MentionMenuInstance {
  selectedIndex: number;
  allItems: MentionNoteItem[];
  visibleCount: number;
  loading: boolean;
}

let menuState: MentionMenuState | null = null;
let menuRoot: Root | null = null;
let menuContainer: HTMLDivElement | null = null;
let activeEditor: Editor | null = null;
let menuInstance: MentionMenuInstance | null = null;

function closeMenu() {
  document.removeEventListener('mousedown', handlePointerDownOutside, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', handleScrollOutside, true);

  if (menuRoot) {
    menuRoot.unmount();
    menuRoot = null;
  }
  if (menuContainer) {
    menuContainer.remove();
    menuContainer = null;
  }

  menuState = null;
  activeEditor = null;
  menuInstance = null;
}

function handlePointerDownOutside(event: MouseEvent) {
  const target = event.target;
  if (target instanceof Node && menuContainer?.contains(target)) return;
  closeMenu();
}

function handleScrollOutside(event: Event) {
  const target = event.target;
  if (target instanceof Node && menuContainer?.contains(target)) return;
  closeMenu();
}

function getQuery(view: EditorView, triggerFrom: number): string | null {
  const { selection } = view.state;
  if (!selection.empty || selection.from < triggerFrom + 1) return null;

  const $trigger = view.state.doc.resolve(triggerFrom);
  const $cursor = view.state.doc.resolve(selection.from);
  if (!$trigger.sameParent($cursor)) return null;

  const text = view.state.doc.textBetween(triggerFrom, selection.from, '\n', '\n');
  if (!text.startsWith('@')) return null;

  const query = text.slice(1);
  if (/[\s]/.test(query)) return null;

  return query;
}

function updatePosition(view: EditorView) {
  if (!menuContainer) return;

  const coords = view.coordsAtPos(view.state.selection.from);
  const spaceBelow = window.innerHeight - coords.bottom - VIEWPORT_PADDING;
  const menuHeight = Math.min(menuContainer.offsetHeight || MENU_MAX_HEIGHT, MENU_MAX_HEIGHT);
  const placeAbove = spaceBelow < MENU_MAX_HEIGHT + MENU_GAP;

  const top = placeAbove
    ? Math.max(VIEWPORT_PADDING, coords.top - menuHeight - MENU_GAP)
    : coords.bottom + MENU_GAP;
  const left = Math.min(
    Math.max(coords.left, VIEWPORT_PADDING),
    Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING),
  );

  menuContainer.style.top = `${top}px`;
  menuContainer.style.left = `${left}px`;
}

function renderMenu(view: EditorView) {
  if (!menuRoot || !menuInstance) return;

  const visibleItems = menuInstance.allItems.slice(0, menuInstance.visibleCount);
  menuRoot.render(
    <MentionNoteDropdown
      items={visibleItems}
      selectedIndex={menuInstance.selectedIndex}
      hasMore={menuInstance.visibleCount < menuInstance.allItems.length}
      loading={menuInstance.loading}
      onHover={(index) => {
        if (!menuInstance) return;
        menuInstance.selectedIndex = index;
        renderMenu(view);
      }}
      onLoadMore={() => {
        if (!menuInstance) return;
        menuInstance.visibleCount = Math.min(
          menuInstance.visibleCount + PAGE_SIZE,
          menuInstance.allItems.length,
        );
        renderMenu(view);
      }}
      onSelect={handleSelect}
    />,
  );

  updatePosition(view);
}

function applyQuery(view: EditorView, query: string, resetPage: boolean) {
  if (!menuInstance) return;
  menuInstance.allItems = queryMentionNotes(query);
  if (resetPage) {
    menuInstance.visibleCount = PAGE_SIZE;
    menuInstance.selectedIndex = 0;
  } else {
    menuInstance.selectedIndex = Math.min(
      menuInstance.selectedIndex,
      Math.max(Math.min(menuInstance.visibleCount, menuInstance.allItems.length) - 1, 0),
    );
  }
  renderMenu(view);
}

function loadAndRender(view: EditorView) {
  if (!menuState || !menuInstance) return;
  const requestId = ++menuState.requestId;
  menuInstance.loading = true;
  renderMenu(view);

  loadMentionNotes().then(() => {
    if (!menuState || !menuInstance || menuState.requestId !== requestId) return;
    menuInstance.loading = false;
    applyQuery(view, menuState.query, true);
  });
}

function openMenu(view: EditorView, editor: Editor, triggerFrom: number) {
  closeMenu();

  menuState = { triggerFrom, query: '', requestId: 0 };
  activeEditor = editor;
  menuInstance = {
    selectedIndex: 0,
    allItems: [],
    visibleCount: PAGE_SIZE,
    loading: true,
  };

  menuContainer = document.createElement('div');
  menuContainer.style.position = 'fixed';
  menuContainer.style.zIndex = '2147483647';
  menuContainer.style.width = `${MENU_WIDTH}px`;
  menuContainer.style.maxHeight = `${MENU_MAX_HEIGHT}px`;
  menuContainer.style.maxWidth = 'calc(100vw - 16px)';
  document.body.appendChild(menuContainer);
  menuRoot = createRoot(menuContainer);

  document.addEventListener('mousedown', handlePointerDownOutside, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', handleScrollOutside, true);

  loadAndRender(view);
}

function deleteTriggerText(editor: Editor): boolean {
  if (!menuState) return false;

  editor.chain().focus().deleteRange({
    from: menuState.triggerFrom,
    to: editor.state.selection.from,
  }).run();
  return true;
}

function handleSelect(item: MentionNoteItem): void {
  if (!activeEditor || !menuState) return;

  const editor = activeEditor;
  deleteTriggerText(editor);
  closeMenu();

  if (!editor.schema.nodes.noteReference) return;
  editor.commands.insertContent({
    type: 'noteReference',
    attrs: toNoteReferenceAttrs(item),
  });
}

function refreshMenuFromEditor(view: EditorView) {
  if (!menuState || !menuInstance) return;

  const query = getQuery(view, menuState.triggerFrom);
  if (query === null) {
    closeMenu();
    return;
  }

  if (query !== menuState.query) {
    menuState.query = query;
    applyQuery(view, query, true);
    return;
  }

  renderMenu(view);
}

export const MentionNote = Extension.create({
  name: 'mentionNote',

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: mentionNotePluginKey,

        view(view) {
          return {
            update(updatedView) {
              if (updatedView !== view || !menuState) return;
              refreshMenuFromEditor(updatedView);
            },
            destroy() {
              closeMenu();
            },
          };
        },

        props: {
          handleTextInput(view, from, _to, text) {
            if (text !== '@') return false;
            if (!editor.isEditable || !view.state.selection.empty) {
              closeMenu();
              return false;
            }

            openMenu(view, editor, from);
            return false;
          },

          handleKeyDown(view, event) {
            if (!menuState || !menuInstance) return false;

            const visibleItems = menuInstance.allItems.slice(0, menuInstance.visibleCount);

            if (event.key === 'ArrowUp') {
              event.preventDefault();
              menuInstance.selectedIndex = menuInstance.selectedIndex > 0
                ? menuInstance.selectedIndex - 1
                : Math.max(visibleItems.length - 1, 0);
              renderMenu(view);
              return true;
            }

            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (
                menuInstance.selectedIndex >= visibleItems.length - 1 &&
                menuInstance.visibleCount < menuInstance.allItems.length
              ) {
                menuInstance.visibleCount = Math.min(
                  menuInstance.visibleCount + PAGE_SIZE,
                  menuInstance.allItems.length,
                );
                menuInstance.selectedIndex += 1;
              } else {
                menuInstance.selectedIndex = menuInstance.selectedIndex < visibleItems.length - 1
                  ? menuInstance.selectedIndex + 1
                  : 0;
              }
              renderMenu(view);
              return true;
            }

            if (event.key === 'Escape') {
              event.preventDefault();
              closeMenu();
              return true;
            }

            if (event.key === 'Enter') {
              event.preventDefault();
              const item = visibleItems[menuInstance.selectedIndex];
              if (item) handleSelect(item);
              return true;
            }

            if (event.key === 'Tab') {
              event.preventDefault();
              const direction = event.shiftKey ? -1 : 1;
              const count = visibleItems.length;
              if (count > 0) {
                menuInstance.selectedIndex = (menuInstance.selectedIndex + direction + count) % count;
                renderMenu(view);
              }
              return true;
            }

            return false;
          },
        },
      }),
    ];
  },
});
