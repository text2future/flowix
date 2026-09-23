import { Extension } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection, Plugin, PluginKey, type EditorState } from 'prosemirror-state'
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

/**
 * A menu pin is only visual context for the block-menu target.  It must not
 * survive a real editor selection that moved to another node, especially an
 * inline atom inside the pinned paragraph.  In that case the NodeView's own
 * selection styling is the single visual selection signal.
 */
export function selectionBelongsToMenuPin(
  state: Pick<EditorState, 'selection'>,
  pin: MenuPinState,
): boolean {
  const { selection } = state

  if (selection instanceof NodeSelection) {
    return selection.from === pin.pos
      && selection.node.type.name === pin.typeName
      && selection.node.nodeSize === pin.nodeSize
  }

  // Text selections are allowed to keep the menu target highlighted only
  // while they remain strictly inside the pinned node.  Strict bounds prevent
  // a cursor immediately before/after an inline atom from being mistaken for
  // a selection of that atom.
  return selection.from > pin.pos
    && selection.to < pin.pos + pin.nodeSize
}

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
              const mappedPin = validatePin(newState.doc, {
                ...value,
                pos: result.pos,
              })
              if (!mappedPin) return null
              return selectionBelongsToMenuPin(newState, mappedPin) ? mappedPin : null
            }

            const validatedPin = validatePin(newState.doc, value)
            if (!validatedPin) return null

            // Selection-only transactions are the important path here: a
            // card NodeSelection can change while the pinned paragraph and
            // document remain untouched.  Clear the stale block decoration
            // as soon as the real selection leaves the pinned target.
            if (tr.selectionSet && !selectionBelongsToMenuPin(newState, validatedPin)) {
              return null
            }

            return validatedPin
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
