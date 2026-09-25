import { Fragment, type Node as PMNode, type Schema } from 'prosemirror-model'

export const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList'])
export const LIST_ITEM_TYPES = new Set(['listItem', 'taskItem'])

export type ListTypeName = 'bulletList' | 'orderedList' | 'taskList'

export function isListTypeName(name: string): name is ListTypeName {
  return LIST_TYPES.has(name)
}

/** A list's items are homogeneous in the ProseMirror schema. */
export function itemTypeForList(type: ListTypeName): 'listItem' | 'taskItem' {
  return type === 'taskList' ? 'taskItem' : 'listItem'
}

export function listWithItems(list: PMNode, items: readonly PMNode[], firstItemIndex = 0): PMNode | null {
  if (!isListTypeName(list.type.name) || items.length === 0) return null
  // Splitting an ordered list must keep the numbering of the right-hand run.
  const attrs = list.type.name === 'orderedList'
    ? { ...list.attrs, start: (Number(list.attrs.start) || 1) + firstItemIndex }
    : list.attrs
  return list.type.createChecked(attrs, Fragment.fromArray([...items]))
}

export function itemsOf(list: PMNode): PMNode[] {
  const items: PMNode[] = []
  list.forEach(item => items.push(item))
  return items
}

/** Joining ordered lists is safe only when the second run continues numbering. */
export function canMergeListRuns(previous: PMNode | null, next: PMNode | null): boolean {
  if (!previous || !next || previous.type !== next.type || !isListTypeName(previous.type.name)) return false
  if (previous.type.name !== 'orderedList') return previous.sameMarkup(next)
  const { start: previousStart, ...previousAttrs } = previous.attrs
  const { start: nextStart, ...nextAttrs } = next.attrs
  const attrKeys = Object.keys(previousAttrs)
  return attrKeys.length === Object.keys(nextAttrs).length
    && attrKeys.every(key => previousAttrs[key] === nextAttrs[key])
    && (Number(previousStart) || 1) + previous.childCount === (Number(nextStart) || 1)
}

export function convertItem(item: PMNode, target: ListTypeName, schema: Schema): PMNode {
  const type = schema.nodes[itemTypeForList(target)]
  if (!type) throw new Error(`Missing item type for ${target}`)
  // Checked state has no Markdown representation on a regular list item.
  // Converting back to a task therefore starts unchecked.
  const attrs = target === 'taskList'
    ? { checked: item.type.name === 'taskItem' ? item.attrs.checked === true : false }
    : undefined
  return type.createChecked(attrs, item.content)
}

export function createListOfType(
  schema: Schema,
  typeName: ListTypeName,
  items: readonly PMNode[],
  attrs?: Record<string, unknown>,
): PMNode {
  const type = schema.nodes[typeName]
  if (!type) throw new Error(`Missing list type ${typeName}`)
  return type.createChecked(attrs, Fragment.fromArray([...items]))
}
