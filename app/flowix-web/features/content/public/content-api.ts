export { ContentIcon, getFileIconKind, HtmlFileIcon, NotebookTreeResourceIcon, WorkDocumentsCollectionIcon } from '../components/content-icon';
export { NoteContentIcon } from '../components/note-content-icon';
export type { ContentDescription, ContentKind, ContentFileIconKind } from '../components/content-icon';

export {
  classifyFileContent,
  fileExtension,
  isCodeTextFilePath,
  isEditableTextFilePath,
  isHtmlFilePath,
  isImageFilePath,
  isMarkdownFilePath,
  isNotebookResourcePath,
  isTextMimeType,
  isVideoFilePath,
  resourceKindFromPath,
} from '../model/content-kind';
export type { FileContentKind, ResourceKind } from '../model/content-kind';
