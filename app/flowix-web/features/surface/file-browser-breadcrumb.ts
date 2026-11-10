import { canonicalPath, findOwningRoot } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';

export interface FileBrowserBreadcrumbItem {
  label: string;
  path: string;
  type: 'folder' | 'file';
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function pathSegments(path: string): string[] {
  return canonicalPath(path).split('/').filter(Boolean);
}

/**
 * Build a compact path breadcrumb relative to the file-browser root.
 *
 * The root is intentionally represented by its last directory name, so an
 * absolute scope such as `/Users/rop/Desktop/vibe/flowix-main` starts with
 * `flowix-main` instead of exposing the whole host path.
 */
export function resolveFileBrowserBreadcrumbs(
  folderPath: string,
  activeFilePath: string | null,
): string[] {
  return resolveFileBrowserBreadcrumbItems(folderPath, activeFilePath).map((item) => item.label);
}

/**
 * Resolve breadcrumb labels together with their filesystem paths.
 *
 * Keeping the path on the item is important for folder popovers: labels alone
 * are ambiguous when a folder name appears more than once in a path, while
 * the clicked folder must become the tree's exact root.
 */
export function resolveFileBrowserBreadcrumbItems(
  folderPath: string,
  activeFilePath: string | null,
): FileBrowserBreadcrumbItem[] {
  const normalizedRoot = trimTrailingSeparators(canonicalPath(folderPath.trim()));
  const rootSegments = pathSegments(normalizedRoot);
  const rootLabel = rootSegments[rootSegments.length - 1] ?? (folderPath || '/');
  const rootItem: FileBrowserBreadcrumbItem = {
    label: rootLabel,
    path: normalizedRoot,
    type: 'folder',
  };
  if (!activeFilePath) return [rootItem];

  const normalizedFile = trimTrailingSeparators(canonicalPath(activeFilePath.trim()));
  if (!normalizedFile || normalizedFile === normalizedRoot) return [rootItem];

  const rootPrefix = normalizedRoot ? `${normalizedRoot}/` : '';
  const relativePath = normalizedFile.startsWith(rootPrefix)
    ? normalizedFile.slice(rootPrefix.length)
    : null;

  // The file tree should only select files below folderPath. Keep the
  // breadcrumb useful if an older/restored tab contains an out-of-scope path.
  if (relativePath === null) {
    return [rootItem, {
      label: pathSegments(normalizedFile).slice(-1)[0] ?? normalizedFile,
      path: normalizedFile,
      type: 'file',
    }];
  }

  let currentPath = normalizedRoot;
  const segments = pathSegments(relativePath);
  return [
    rootItem,
    ...segments.map((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      return {
        label: segment,
        path: currentPath,
        type: index === segments.length - 1 ? 'file' : 'folder',
      } satisfies FileBrowserBreadcrumbItem;
    }),
  ];
}

/**
 * Breadcrumb for a document header: identical path split as the file browser,
 * but the current file is labelled with the file tree's display rule, so
 * `AGENTS.md` reads `AGENTS` (notes, tables, indexes, HTML drop the suffix).
 *
 * Only the trailing file segment is rewritten; folder segments keep their raw
 * names, and an unrenderable label (e.g. a lone `.index.yaml`) falls back to
 * the real filename so the header never loses its identity.
 */
export function resolveDocumentBreadcrumbItems(
  folderPath: string,
  activeFilePath: string | null,
): FileBrowserBreadcrumbItem[] {
  return resolveFileBrowserBreadcrumbItems(folderPath, activeFilePath).map((item) => (
    item.type === 'file' ? { ...item, label: displayTitleFromFilename(item.label) || item.label } : item
  ));
}

export interface DocumentBreadcrumbQuery {
  filePath: string | null | undefined;
  /** Collection index path: collections keep their own tabbed shell, so they get no breadcrumb. */
  collectionIndexPath?: string | null;
  /** Candidate roots in priority order (target scope, external session, browser scope...). */
  scopeRoots?: readonly (string | null | undefined)[];
  /** Notebook roots for the ownership lookup; surfaces such as the file tree carry no scope. */
  notebookRoots?: readonly string[];
  /** Root of the tree the file was opened from; last resort, keeps a short relative trail. */
  treeRoot?: string | null;
}

/**
 * The one root-resolution chain for document headers, shared by both columns.
 *
 * Order matters: an explicit scope is authoritative, notebook ownership is the
 * fallback when the surface carries none (file tree / access space), and the
 * tree root only exists so the header never goes blank.
 */
export function resolveDocumentBreadcrumb(
  query: DocumentBreadcrumbQuery,
): FileBrowserBreadcrumbItem[] | null {
  const filePath = query.filePath?.trim();
  if (!filePath || query.collectionIndexPath) return null;

  const explicitRoot = query.scopeRoots?.find((root) => Boolean(root?.trim())) ?? null;
  const root = explicitRoot
    ?? findOwningRoot(filePath, query.notebookRoots ?? [])
    ?? (query.treeRoot?.trim() || null);
  return root ? resolveDocumentBreadcrumbItems(root, filePath) : null;
}
