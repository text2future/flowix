export const COLLECTION_AGENT_REFERENCE_LINK_TITLE = 'flowix:collection';

export interface CollectionAgentReference {
  collectionId: string | null;
  notebookId: string;
  collectionPath: string;
  indexPath: string | null;
}

function escapeMarkdownLabel(label: string): string {
  const safeLabel = [...label]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
    })
    .join('');
  return safeLabel
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function encodeTokenValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Build the prompt context that lets an agent locate and read this collection. */
export function buildCollectionAgentPrompt(
  question: string,
  name: string,
  reference: CollectionAgentReference,
): string {
  const displayName = name.trim() || 'Collection';
  const metadata = {
    type: 'flowix.collection',
    readInstruction: '通过 Flowix 集合 CLI/MCP 读取该集合后回答用户问题。',
    collectionId: reference.collectionId,
    notebookId: reference.notebookId,
    collectionPath: reference.collectionPath,
    indexPath: reference.indexPath,
  };
  const collectionToken = `flowix://collection/${encodeTokenValue(reference.collectionPath)}?metadata=${encodeTokenValue(JSON.stringify(metadata))}`;
  const link = `[${escapeMarkdownLabel(`@${displayName}`)}](${collectionToken})`;

  return [
    question.trim(),
    '',
    `参考集合资料 ${link}`,
  ].join('\n');
}
