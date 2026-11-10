import type { JSONContent } from '@tiptap/core';
import { DOMSerializer, type Schema } from '@tiptap/pm/model';

/**
 * One serializer per schema; `DOMSerializer.fromSchema` walks every node and
 * mark, so callers must never build one per event or per node.
 *
 * This is the only serializer cache in the table feature. `table-composition`
 * repairs IME output on every `input` event, which used to construct a fresh
 * serializer each time.
 */
const serializerBySchema = new WeakMap<Schema, DOMSerializer>();

export function schemaSerializer(schema: Schema): DOMSerializer {
  const cached = serializerBySchema.get(schema);
  if (cached) return cached;
  const serializer = DOMSerializer.fromSchema(schema);
  serializerBySchema.set(schema, serializer);
  return serializer;
}

/**
 * Serialize one table node as a single-line HTML string.
 *
 * A blank source line ends a CommonMark HTML block. Character references keep
 * the table on one source line and decode back to literal newlines inside
 * pre/code when the schema parses the HTML.
 */
export function serializeTableHtml(node: JSONContent, schema: Schema, ownerDocument?: Document): string {
  const documentForSerialization = ownerDocument ?? schemaDocument();
  const container = documentForSerialization.createElement('div');
  container.appendChild(schemaSerializer(schema).serializeNode(schema.nodeFromJSON(node)));
  return container.innerHTML.replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}

/**
 * Serialization is only reachable from an editor, but tests and scripts can
 * call it without a DOM, so `document` is not a given.
 */
function schemaDocument(): Document {
  if (typeof document === 'undefined') {
    throw new Error('[flowix-table] HTML table serialization needs a document; no DOM is installed.');
  }
  return document;
}
