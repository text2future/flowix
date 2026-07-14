import { Extension } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export interface MenuPinState {
  pos: number
  typeName: string
  nodeSize: number
}

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
 *   editor.view.dispatch(editor.view.state.tr.setMeta(menuPinPluginKey, pin))
 *   editor.view.dispatch(editor.view.state.tr.setMeta(menuPinPluginKey, null))
 *
 * The `pos` is the open-token position of the block. The plugin stores
 * typeName/nodeSize with it so mapped positions are only kept when they
 * still point to the same node. Decorations cover `pos .. pos + nodeSize`.
 */
export const menuPinPluginKey = new PluginKey<MenuPinState | null>('menuPin')

export const MenuPinExtension = Extension.create({
  name: 'menuPin',

  addProseMirrorPlugins() {
    return [
      new Plugin<MenuPinState | null>({
        key: menuPinPluginKey,
        state: {
          init: () => null,
          apply(tr, value, _oldState, newState) {
            // External API takes priority (drag-context-menu dispatches
            // a transaction with setMeta to set or clear the pin).
            const meta = tr.getMeta(menuPinPluginKey) as MenuPinState | null | undefined
            if (meta !== undefined) return meta

            // On doc changes, map the pinned position through the
            // transaction before validating it. Without this, edits before
            // the pinned block can leave the decoration attached to the
            // wrong node.
            if (value != null && tr.docChanged) {
              const result = tr.mapping.mapResult(value.pos, -1)
              if (result.deleted) return null
              return validatePin(newState.doc, {
                ...value,
                pos: result.pos,
              })
            }

            return validatePin(newState.doc, value)
          },
        },
        props: {
          decorations(state) {
            const pin = validatePin(state.doc, menuPinPluginKey.getState(state) ?? null)
            if (pin == null) return null
            const node = state.doc.nodeAt(pin.pos)
            if (!node) return null
            return DecorationSet.create(state.doc, [
              Decoration.node(pin.pos, pin.pos + node.nodeSize, { class: 'is-block-selected' }),
            ])
          },
        },
      }),
    ]
  },
})

function validatePin(doc: PMNode, pin: MenuPinState | null): MenuPinState | null {
  if (pin == null) return null
  if (pin.pos < 0 || pin.pos > doc.content.size) return null

  try {
    doc.resolve(pin.pos)
    const node = doc.nodeAt(pin.pos)
    if (!node) return null
    if (node.type.name !== pin.typeName) return null
    if (node.nodeSize !== pin.nodeSize) return null
    return pin
  } catch {
    return null
  }
}
