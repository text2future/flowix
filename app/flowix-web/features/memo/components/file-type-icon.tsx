import { forwardRef } from 'react';
import type { Icon, IconProps } from '@phosphor-icons/react';
import { GalleryHorizontalEnd } from 'lucide-react';
import {
  FileCodeIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileImageIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  FileZipIcon,
} from '@phosphor-icons/react';
import {
  fileExtension,
  isCodeTextFilePath,
  isImageFilePath,
  isMarkdownFilePath,
  isVideoFilePath,
} from '@features/editor/code-file';

const DOCUMENT_EXTENSIONS = new Set(['doc', 'docm', 'docx', 'dot', 'dotx', 'odt', 'rtf']);
const HTML_EXTENSIONS = new Set(['htm', 'html', 'xhtml']);
const PRESENTATION_EXTENSIONS = new Set(['key', 'odp', 'pot', 'potx', 'ppt', 'pptm', 'pptx']);
const ARCHIVE_EXTENSIONS = new Set([
  '7z', 'bz', 'bz2', 'cab', 'gz', 'iso', 'lz', 'lzma', 'rar', 'tar', 'tgz', 'xz', 'zip', 'zst',
]);
const SPREADSHEET_EXTENSIONS = new Set(['csv', 'numbers', 'ods', 'tsv', 'xls', 'xlsb', 'xlsm', 'xlsx', 'xlt', 'xltx']);

export type FileIconKind =
  | 'markdown'
  | 'html'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'pdf'
  | 'video'
  | 'archive'
  | 'image'
  | 'code'
  | 'fallback';

const PHOSPHOR_ICON_BY_KIND: Record<FileIconKind, Icon> = {
  markdown: FileMdIcon,
  html: FileHtmlIcon,
  document: FileDocIcon,
  presentation: FilePptIcon,
  spreadsheet: FileXlsIcon,
  pdf: FilePdfIcon,
  video: FileVideoIcon,
  archive: FileZipIcon,
  image: FileImageIcon,
  code: FileCodeIcon,
  fallback: FileTextIcon,
};

/** Resolve a file's semantic icon kind once for every file-tree renderer. */
export function getFileIconKind(path: string): FileIconKind {
  if (isTableDocumentPath(path)) return 'spreadsheet';
  const extension = fileExtension(path);

  if (isMarkdownFilePath(path)) return 'markdown';
  if (HTML_EXTENSIONS.has(extension)) return 'html';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (PRESENTATION_EXTENSIONS.has(extension)) return 'presentation';
  if (SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
  if (extension === 'pdf') return 'pdf';
  if (isVideoFilePath(path)) return 'video';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  if (isImageFilePath(path)) return 'image';
  if (isCodeTextFilePath(path)) return 'code';

  return 'fallback';
}

/** Resolve the legacy Phosphor component for callers that need it. */
export function getFileIcon(path: string): Icon {
  return PHOSPHOR_ICON_BY_KIND[getFileIconKind(path)];
}

export function FileTypeIcon({ path, className }: { path: string; className?: string }) {
  if (/\.lib\.ya?ml$/i.test(path)) return <GalleryHorizontalEnd aria-hidden="true" className={className} />;
  if (isTableDocumentPath(path)) {
    return <TableDocumentIcon className={className} />;
  }
  const kind = getFileIconKind(path);
  if (kind === 'image' || kind === 'video' || kind === 'code' || kind === 'fallback') {
    return <CustomFileIcon kind={kind} className={className} />;
  }

  const IconComponent = PHOSPHOR_ICON_BY_KIND[kind];
  return <IconComponent aria-hidden="true" className={className} />;
}

/** Resolve the custom icons used for non-note files in the notebook tree. */
export function NotebookTreeResourceIcon({ path, className }: { path: string; className?: string }) {
  if (/\.lib\.ya?ml$/i.test(path)) return <MediaLibraryIcon className={className} />;
  if (isTableDocumentPath(path)) {
    return <TableDocumentIcon className={className} />;
  }
  return <CustomFileIcon kind={getFileIconKind(path)} className={className} />;
}

function isTableDocumentPath(path: string): boolean {
  return /\.table\.ya?ml$/i.test(path);
}

/**
 * 多维表格 (`.table.yaml`) 的统一图标 ── 侧边栏文件树、文档视图、slash 菜单
 * 「视图」分区共用。导出为 Phosphor 兼容组件 (forwardRef + IconProps),
 * 以便直接作为 SlashMenuItem.icon 使用 (多余的 weight 等 props 会被忽略)。
 */
export const TableDocumentIcon = forwardRef<SVGSVGElement, IconProps>(
  function TableDocumentIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
        <g transform="translate(1.5 1.5) scale(0.625)" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18" />
        </g>
      </svg>
    );
  },
);

export const MediaLibraryIcon = forwardRef<SVGSVGElement, IconProps>(
  function MediaLibraryIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
        <g transform="translate(1.5 1.5) scale(0.625)" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 7v10" />
          <path d="M6 5v14" />
          <rect width="12" height="18" x="10" y="3" rx="2" />
        </g>
      </svg>
    );
  },
);

function CustomFileIcon({ kind, className }: { kind: FileIconKind; className?: string }) {
  if (kind === 'image') return <ImageFileIcon className={className} />;
  if (kind === 'video') return <VideoFileIcon className={className} />;
  if (kind === 'code') return <CodeFileIcon className={className} />;
  return <FallbackFileIcon className={className} />;
}

export function CodeFileIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
      <path d="M5.25 5.37L2.87 7.53C2.01 8.33 2.01 9.05 2.87 9.85L5.25 11.93" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.6 1.8L7.3 16.3" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.76 5.37L15.13 7.53C15.99 8.33 15.99 9.05 15.13 9.85L12.76 11.93" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FallbackFileIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
      <g transform="matrix(0.6923077 0 0 0.6923077 0.6923077 0.6923077)">
        <path d="M 3.6667 19 V 5 c 0 -1.4733 1.1933 -2.6667 2.6667 -2.6667 h 7.448 c 0.3533 0 0.6933 0.14 0.9427 0.3907 l 5.2187 5.2187 c 0.2507 0.2507 0.3907 0.5893 0.3907 0.9427 v 10.1146 c 0 1.4733 -1.1933 2.6667 -2.6667 2.6667 H 6.3333 c -1.4733 0 -2.6667 -1.1933 -2.6667 -2.6667 Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <path d="M 20.2133 8.3333 h -4.5467 c -0.736 0 -1.3333 -0.5973 -1.3333 -1.3333 V 2.4693" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

export function VideoFileIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
      <rect x="1.8" y="3.6" width="11.8" height="10.8" rx="1.8" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.6 7.08L16 5.16C16.6 4.68 17.3 5.16 17.3 6V12C17.3 12.84 16.6 13.32 16 12.84L13.6 10.92V7.08Z" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ImageFileIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="64"
      height="64"
      viewBox="0 0 18 18"
      fill="none"
      opacity={0.6}
      aria-hidden="true"
      className={className}
    >
      <g transform="matrix(0.6666667 0 0 0.6666667 1 1)">
        <path d="M21.6799 16.9599L18.5499 9.64988C17.4899 7.16988 15.5399 7.06988 14.2299 9.42988L12.3399 12.8399C11.3799 14.5699 9.58993 14.7199 8.34993 13.1699L8.12993 12.8899C6.83993 11.2699 5.01993 11.4699 4.08993 13.3199L2.36993 16.7699C1.15993 19.1699 2.90993 21.9999 5.58993 21.9999H18.3499C20.9499 21.9999 22.6999 19.3499 21.6799 16.9599Z" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6.96997 8C8.62682 8 9.96997 6.65685 9.96997 5C9.96997 3.34315 8.62682 2 6.96997 2C5.31312 2 3.96997 3.34315 3.96997 5C3.96997 6.65685 5.31312 8 6.96997 8Z" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
