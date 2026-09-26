/** Public file-resource classification used by other feature boundaries. */
export {
  fileExtension,
  isMarkdownFilePath,
  isCodeTextFilePath,
  isEditableTextFilePath,
  isImageFilePath,
  isVideoFilePath,
  isHtmlFilePath,
  externalFileViewKind,
  isNotebookResourcePath,
  resourceKindFromPath,
} from '../code-file';

export type { ExternalFileViewKind, ResourceKind } from '../code-file';
