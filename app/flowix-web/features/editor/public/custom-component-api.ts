import { samePath } from '@/lib/path';
import type { NotebookCustomComponent } from '../extensions/custom-component-format';

/** Public bridge for loading notebook components and inserting them in the active Markdown editor. */
export {
  componentPreviewDocument,
  getComponentPreviewHeight,
  parseNotebookComponent,
} from '../extensions/custom-component-format';
export type {
  CustomComponent,
  NotebookCustomComponent,
} from '../extensions/custom-component-format';

export interface CustomComponentEditorTarget {
  notebookPath: string;
  documentPath: string;
  insert: (component: NotebookCustomComponent) => boolean;
}

const customComponentEditorTargets = new Set<CustomComponentEditorTarget>();

export function registerCustomComponentEditorTarget(target: CustomComponentEditorTarget): () => void {
  customComponentEditorTargets.add(target);
  return () => customComponentEditorTargets.delete(target);
}

export function insertCustomComponentIntoEditor(
  notebookPath: string,
  documentPath: string | null | undefined,
  component: NotebookCustomComponent,
): boolean {
  if (!documentPath) return false;
  const target = [...customComponentEditorTargets].reverse().find((candidate) => (
    samePath(candidate.notebookPath, notebookPath)
    && samePath(candidate.documentPath, documentPath)
  ));
  return target?.insert(component) ?? false;
}
