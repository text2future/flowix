/** Public file-resource classification used by other feature boundaries. */
export {
  fileExtension,
  isMarkdownFilePath,
  isCodeTextFilePath,
  isEditableTextFilePath,
  isImageFilePath,
  isVideoFilePath,
  isHtmlFilePath,
  isNotebookResourcePath,
  resourceKindFromPath,
} from '../code-file';

export type { ResourceKind } from '../code-file';
