import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

/**
 * Editor-wide "menu pin" plugin.
 *
 * Tracks a single ProseMirror position that the drag-context-menu has
 * pinned for visual emphasis (the block whose transform / delete commands
 * are about to fire). The plugin emits a `Decoration.node` covering that
 * position with class `is-block-selected`, so the block-level highlight
 * survives any DOM mutation:
 *
 *   - ProseMirror re-renders (decorations are re-applied every view update)
 *   - React effect re-runs (no DOM coupling to React state)
 *   - External class-stripping code (the class is restored on the next
 *     view update automatically)
 *
 * The position is set / cleared via the standard transaction metadata API:
 *
 *   editor.view.dispatch(editor.view.state.tr.setMeta(menuPinPluginKey, pos))
 *   editor.view.dispatch(editor.view.state.tr.setMeta(menuPinPluginKey, null))
 *
 * The `pos` is the open-token position of the block (same value the
 * drag-context-menu uses for `deleteRange`). A range `pos .. pos + 1`
 * is the smallest valid range for a `Decoration.node`.
 */
export const menuPinPluginKey = new PluginKey<number | null>('menuPin')

export const MenuPinExtension = Extension.create({
  name: 'menuPin',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: menuPinPluginKey,
        state: {
          init: () => null,
          apply(tr, value, _oldState, newState) {
            // External API takes priority (drag-context-menu dispatches
            // a transaction with setMeta to set or clear the pin).
            const meta = tr.getMeta(menuPinPluginKey)
            if (meta !== undefined) return meta

            // On doc changes, re-validate the pinned position. If the
            // position is out of range or no longer points to a block,
            // drop the pin (e.g. the user deleted the block via the menu).
            if (value != null && tr.docChanged) {
              try {
                const $pos = newState.doc.resolve(value)
                if ($pos.depth < 1) return null
                return value
              } catch {
                return null
              }
            }

            return value
          },
        },
        props: {
          decorations(state) {
            const pos = menuPinPluginKey.getState(state)
            if (pos == null) return null
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + 1, { class: 'is-block-selected' }),
            ])
          },
        },
      }),
    ]
  },
})
