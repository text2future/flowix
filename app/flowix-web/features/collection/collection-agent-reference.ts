export const COLLECTION_AGENT_REFERENCE_LINK_TITLE = 'flowix:collection';

export interface CollectionAgentReference {
  collectionId: string | null;
  supportsNotes?: boolean;
  notebookId: string;
  collectionPath: string;
  indexPath: string | null;
}

/** Serialize the stable collection context stored in a composer reference chip. */
export function buildCollectionAgentReferenceMetadata(reference: CollectionAgentReference): string {
  return JSON.stringify({
    type: 'flowix.collection',
    readInstruction: '通过 Flowix 集合 CLI/MCP 读取该集合后回答用户问题。',
    ...(reference.supportsNotes ? { addNoteInstruction: '如果用户要求在此集合中新建或追加笔记，使用 memo 的 collection.add-note 操作，并传入此集合的 collectionId 或 path、笔记标题和完整 Markdown 内容；不要只用通用 create 新建未关联的笔记。' } : {}),
    collectionId: reference.collectionId,
    notebookId: reference.notebookId,
    collectionPath: reference.collectionPath,
    indexPath: reference.indexPath,
  });
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
  const collectionToken = `flowix://collection/${encodeTokenValue(reference.collectionPath)}?metadata=${encodeTokenValue(buildCollectionAgentReferenceMetadata(reference))}`;
  const link = `[${escapeMarkdownLabel(`@${displayName}`)}](${collectionToken})`;

  return [
    question.trim(),
    '',
    `参考集合资料 ${link}`,
    ...(reference.supportsNotes ? ['如需在该集合新增笔记，请调用 Flowix MCP 的 collection.add-note，将笔记创建并关联为表格记录。'] : []),
  ].join('\n');
}

/**
 * 文件夹表面的同一段上下文 —— 文件夹不是集合，没有 `collectionId` / `indexPath`
 * 可给，所以引用写成 `flowix://folder/<绝对路径>`：它表示「这个目录」，由 Agent
 * 用自己的文件工具读，而不是让集合协议去解析一个不存在的集合文件。
 */
export function buildFolderAgentPrompt(question: string, name: string, folderPath: string): string {
  const displayName = name.trim() || 'Folder';
  const link = `[${escapeMarkdownLabel(`@${displayName}`)}](flowix://folder/${encodeTokenValue(folderPath)})`;
  return [question.trim(), '', `参考文件夹 ${link}`].join('\n');
}
