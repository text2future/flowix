import { Extension, Editor } from '@tiptap/core';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

function formatChineseDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  return `${year}年${month}月${day}日 ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

let currentUpdatedAt: Date | null = null;

export const DateTimeWidget = Extension.create({
  name: 'datetimeWidget',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('datetimeWidget'),
        props: {
          decorations(state) {
            if (!currentUpdatedAt) return DecorationSet.empty;

            const dateStr = formatChineseDateTime(currentUpdatedAt);
            const dom = document.createElement('div');
            dom.className = 'editor-datetime-widget';
            dom.textContent = dateStr;

            return DecorationSet.create(state.doc, [
              Decoration.widget(0, dom, { side: 1 }),
            ]);
          },
        },
      }),
    ];
  },
});

export function updateDateTimeWidget(editor: Editor, date: Date | null) {
  currentUpdatedAt = date;
  editor.view.dispatch(editor.state.tr.setMeta('datetimeWidgetUpdate', true));
}