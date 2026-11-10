import { forwardRef, useId } from 'react';
import type { Icon, IconProps } from '@phosphor-icons/react';
import { Folder, Globe } from 'lucide-react';
import { FileMdIcon } from '@phosphor-icons/react';
import { classifyFileContent, type FileContentKind } from '@features/content/model/content-kind';
import { NoteContentIcon } from './note-content-icon';
import { WorkDocumentsIcon as WorkDocumentsCollectionIcon } from './work-documents-icon';

export { WorkDocumentsCollectionIcon };

export type ContentFileIconKind = FileContentKind | 'fallback';

/**
 * 三个设计稿彩色图标（Word / Excel / PPT）统一压到 0.8：实心填色不压一层，
 * 在同一排单色描边图标里会明显更重。改这里就是三个一起改。
 */
const COLORED_FILE_ICON_OPACITY = 0.8;

/**
 * 演示文稿（ppt / pptx / key / odp …）的彩色图标。
 *
 * 取自设计稿的 Slides item 图标，但只保留内部图形：外层白底卡片 + 描边 + 投影
 * 属于「item 卡片」容器，放进文件树会多出一层框，整块去掉。
 * 原稿图形占 36×38 画布里的 (10,8)-(28,26) 这 18×18 区域，这里等比缩到 14.6 并居中
 * （matrix 把 (10,8)-(28,26) 映射到 (1.6875,1.6875)-(16.3125,16.3125)），
 * 与其它文件图标共用 18×18 视框，视觉高度也和笔记图标对齐。
 */
export const PresentationFileIcon = forwardRef<SVGSVGElement, IconProps>(
  function PresentationFileIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={COLORED_FILE_ICON_OPACITY} aria-hidden="true" className={className}>
        <g transform="matrix(0.8125 0 0 0.8125 -6.4375 -4.8125)">
          <path fill="#E97446" d="M10 18a8 8 0 1 1 16 0 8 8 0 0 1-16 0" />
          <path fill="#F2BAA5" d="M18 8c5.523 0 10 4.477 10 10H18z" />
          <path fill="#EC8962" d="M10 18a8 8 0 0 1 8-8v8z" />
        </g>
      </svg>
    );
  },
);

/**
 * 表格（xls / xlsx / csv / tsv / numbers / ods …）的彩色图标。
 *
 * 取自设计稿的 DataAnalysis item 图标，与演示文稿图标相反，这里**保留**外层白底卡片：
 * 网格和顶部绿色表头都是从卡片边缘起算的（x 3–33、y 3–31），去掉卡片会剩一块浮空的网格。
 * 卡片 30×28，用 matrix 缩到 14×13.07 居中进 18×18 视框（映射到 (2,2.47)-(16,15.53)）；
 * 卡片描边走 non-scaling-stroke，缩到 18px 也还是 1px，不会被抹平。
 * 原稿投影用 CSS drop-shadow 复刻（dy 2 / 模糊 3 / 6% 黑），避免 filter id 在多次渲染时重复。
 */
export const SpreadsheetFileIcon = forwardRef<SVGSVGElement, IconProps>(
  function SpreadsheetFileIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={COLORED_FILE_ICON_OPACITY} aria-hidden="true" className={className}>
        <g transform="matrix(0.4667 0 0 0.4667 0.6 1.0667)" style={{ filter: 'drop-shadow(0 2px 3px rgba(28, 28, 32, 0.06))' }}>
          <path fill="#fff" d="M3 11a8 8 0 0 1 8-8h14a8 8 0 0 1 8 8v14a8 8 0 0 1-8 8H11a8 8 0 0 1-8-8z" />
          <path stroke="#E8E8E8" vectorEffect="non-scaling-stroke" d="M11 3.5h14a7.5 7.5 0 0 1 7.5 7.5v14a7.5 7.5 0 0 1-7.5 7.5H11A7.5 7.5 0 0 1 3.5 25V11A7.5 7.5 0 0 1 11 3.5Z" />
          <path fill="#D9D9D9" d="M12 12v5h21v1H12v6h21v1H12v8h-1v-8H3v-1h8v-6H3v-1h8v-5z" />
          <path fill="#2BBC6B" d="M33 12H3v-1.125C3 6.525 6.358 3 10.5 3h15c4.142 0 7.5 3.526 7.5 7.875z" />
        </g>
      </svg>
    );
  },
);

/**
 * 文档（doc / docx / odt / rtf …）的彩色图标。
 *
 * 取自设计稿的 Feature document item 图标，作了两处简化：Figma 导出的
 * `foreignObject` + `backdrop-filter` 玻璃层在高倍缩放下没有可见贡献（18px 文件树里更是不可见），
 * 连同一组「垫在浅色横条下面、几何完全相同」的深蓝副本一起删掉，只留渐变纸面 + 三根浅色横条。
 * 纸面 27×31（x 4–31、y 2–33），用 matrix 缩到 12.19×14 居中进 18×18 视框
 * （映射到 (1.09,1.1)-(13.28,15.1)），高度和笔记图标对齐。
 * 渐变 id 走 useId：同一个列表里会同时渲染几十个实例，固定 id 会撞车。
 */
export const DocumentFileIcon = forwardRef<SVGSVGElement, IconProps>(
  function DocumentFileIcon({ className }, ref) {
    const gradientId = useId();
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={COLORED_FILE_ICON_OPACITY} aria-hidden="true" className={className}>
        <g transform="matrix(0.4516 0 0 0.4516 1.0935 1.097)">
          <rect width="27" height="31" x="4" y="2" rx="6" fill={`url(#${gradientId})`} />
          <rect width="8" height="3" x="10" y="10" rx="1.5" fill="#B4C9FF" />
          <rect width="15" height="3" x="10" y="16" rx="1.5" fill="#B4C9FF" />
          <rect width="15" height="3" x="10" y="22" rx="1.5" fill="#B4C9FF" />
        </g>
        <defs>
          <linearGradient id={gradientId} x1="17.5" x2="17.5" y1="2" y2="33" gradientUnits="userSpaceOnUse">
            <stop stopColor="#789EFF" />
            <stop offset="1" stopColor="#6693FC" />
          </linearGradient>
        </defs>
      </svg>
    );
  },
);

/**
 * PDF 的彩色图标：红色纸面 + 浅红折角 + 白色「PDF」字样。
 *
 * 原稿是 1024 画布的图标字体产物，只取三条路径（去掉 `p-id` / `class` / `t` 这些导出残留）。
 * 纸面占 x 149.33–874.67、y 85.33–938.67（725×853），等比缩到 11.9×14 并让中心 (512,512)
 * 落在 (9,9)，即 `matrix(0.0164062 … 0.6 0.6)`，映射到 (3.05,2)-(14.95,16)。
 */
export const PdfFileIcon = forwardRef<SVGSVGElement, IconProps>(
  function PdfFileIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={COLORED_FILE_ICON_OPACITY} aria-hidden="true" className={className}>
        <g transform="matrix(0.0164062 0 0 0.0164062 0.6 0.6)">
          <path fill="#FF5959" d="M643.669333 110.336l205.994667 205.994667A85.333333 85.333333 0 0 1 874.666667 376.682667V810.666667a128 128 0 0 1-128 128H277.333333a128 128 0 0 1-128-128V213.333333a128 128 0 0 1 128-128h305.984a85.333333 85.333333 0 0 1 60.352 25.002667z" />
          <path fill="#FFB5AD" d="M554.666667 128v234.666667a42.666667 42.666667 0 0 0 42.666666 42.666666h234.666667c38.016 0 57.045333-45.952 30.165333-72.832l-234.666666-234.666666C600.618667 70.954667 554.666667 89.984 554.666667 128z" />
          <path fill="#FFFFFF" d="M363.882667 757.632v-70.997333c3.733333 5.76 7.573333 10.112 11.498666 13.12 7.168 5.418667 16.170667 8.106667 26.986667 8.106666 17.002667 0 30.912-6.272 41.685333-18.858666 10.794667-12.586667 16.213333-30.869333 16.213334-54.869334 0-22.762667-5.546667-40-16.576-51.754666a53.376 53.376 0 0 0-40.448-17.621334c-10.901333 0-20.330667 3.029333-28.245334 9.109334a57.173333 57.173333 0 0 0-12.245333 14.016v-20.138667h-34.133333v189.866667h35.264z m29.12-79.637333c-6.826667 0-12.757333-1.877333-17.749334-5.610667-8.426667-6.421333-12.629333-17.557333-12.629333-33.386667 0-10.005333 1.258667-18.24 3.754667-24.746666 4.821333-12.245333 13.696-18.368 26.624-18.368 10.752 0 18.517333 4.053333 23.317333 12.117333 4.778667 8.085333 7.189333 17.365333 7.189333 27.882667 0 12.736-2.624 22.954667-7.829333 30.613333-5.205333 7.68-12.757333 11.52-22.677333 11.52zM533.76 708.266667c9.664 0 17.749333-1.834667 24.234667-5.504 6.506667-3.648 12.288-9.536 17.386666-17.621334V704h34.624v-184H573.866667v65.002667a43.264 43.264 0 0 0-15.616-15.061334 43.946667 43.946667 0 0 0-21.994667-5.44c-17.92 0-32.234667 6.656-42.944 19.989334s-16.064 31.637333-16.064 54.890666c0 20.16 5.44 36.693333 16.32 49.557334s24.256 19.306667 40.192 19.306666z m10.24-29.994667c-10.090667 0-17.6-3.776-22.570667-11.306667-4.949333-7.552-7.424-17.621333-7.424-30.186666 0-11.669333 2.432-21.44 7.317334-29.312 4.864-7.893333 12.501333-11.818667 22.933333-11.818667 6.826667 0 12.821333 2.154667 17.984 6.506667 8.426667 7.168 12.629333 19.072 12.629333 35.733333 0 11.925333-2.624 21.632-7.872 29.141333-5.248 7.488-12.906667 11.242667-22.997333 11.242667zM683.733333 704v-109.866667h23.381334v-25.130666h-23.36v-11.52c0-2.645333 0.896-5.077333 2.688-7.296 1.792-2.197333 5.034667-3.242667 9.749333-3.114667 4.693333 0.106667 8.064 0.298667 10.048 0.554667v-29.013334a742.826667 742.826667 0 0 0-7.488-0.554666 90.709333 90.709333 0 0 0-6.122667-0.192c-19.754667 0-32.213333 4.096-37.376 12.266666-4.906667 5.482667-7.381333 15.530667-7.381333 30.122667v8.746667h-19.498667v25.130666h19.882667V704h35.498667z" />
        </g>
      </svg>
    );
  },
);

/**
 * 网页（html / htm）的彩色图标：四色标志稿（红 #EA4335 / 蓝 #4285F4 / 绿 #34A853 / 黄 #FBBC05）。
 *
 * 原稿是 1024 画布的图标字体产物，四条路径的联合 bbox 已经铺满整块画布
 * （实测 x/y 都是 0→1024；红色扇面的贝塞尔控制点探到负 y，但曲线本身没出框），
 * 所以直接等比缩到 14×14 居中：`matrix(0.0136719 … 2 2)`，映射到 (2,2)-(16,16)。
 * 只去掉 `p-id` / `class` / `t` 这些导出残留。
 */
export const HtmlFileIcon = forwardRef<SVGSVGElement, IconProps>(
  function HtmlFileIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={COLORED_FILE_ICON_OPACITY} aria-hidden="true" className={className}>
        <g transform="matrix(0.0136719 0 0 0.0136719 2 2)">
          <path fill="#EA4335" d="M123.648 178.346667C361.642667-98.602667 802.986667-43.946667 967.936 279.68h-396.501333c-71.424 0-117.546667-1.621333-167.509334 24.661333-58.709333 30.933333-102.997333 88.234667-118.485333 155.52L123.648 178.389333z" />
          <path fill="#4285F4" d="M341.674667 512c0 93.866667 76.330667 170.24 170.154666 170.24 93.866667 0 170.154667-76.373333 170.154667-170.24s-76.330667-170.24-170.154667-170.24c-93.866667 0-170.154667 76.373333-170.154666 170.24z" />
          <path fill="#34A853" d="M577.877333 734.848c-95.530667 28.373333-207.274667-3.114667-268.501333-108.8-46.762667-80.64-170.24-295.765333-226.346667-393.557333-196.565333 301.226667-27.136 711.808 329.685334 781.866666l165.12-279.509333z" />
          <path fill="#FBBC05" d="M669.866667 341.76a233.130667 233.130667 0 0 1 43.008 286.634667c-40.576 69.973333-170.154667 288.682667-232.96 394.581333 367.658667 22.656 635.733333-337.664 514.645333-681.258667H669.866667z" />
        </g>
      </svg>
    );
  },
);

/**
 * 有专属图形的分类查找表。image / video / code 走自绘描边组件、archive / text /
 * unknown / fallback 统一空白纸页（见 FileKindIcon），都不进这张表。
 */
const ICON_BY_KIND: Record<'note' | 'html' | 'document' | 'presentation' | 'spreadsheet' | 'pdf', Icon> = {
  note: FileMdIcon,
  html: HtmlFileIcon,
  document: DocumentFileIcon,
  presentation: PresentationFileIcon,
  spreadsheet: SpreadsheetFileIcon,
  pdf: PdfFileIcon,
};

/** Flat icon categories; special resources sit beside file categories. */
export type ContentKind = FileContentKind | 'folder' | 'web' | 'media-library' | 'multidimensional-table' | 'work-documents';

export type ContentDescription =
  | { kind: 'file'; path: string; mimeType?: string | null }
  | { kind: ContentKind };

/** One renderer for content icons; callers provide facts and layout only. */
export function ContentIcon({ content, className }: { content: ContentDescription; className?: string }) {
  const kind = content.kind === 'file'
    ? isWorkDocumentsCollectionPath(content.path) ? 'work-documents' : getFileIconKind(content.path, content.mimeType)
    : content.kind;
  if (kind === 'folder') return <Folder aria-hidden="true" className={className} />;
  if (kind === 'web') return <Globe aria-hidden="true" className={className} />;
  if (kind === 'note') return <NoteContentIcon className={className} />;
  if (kind === 'media-library') return <MediaLibraryIcon className={className} />;
  if (kind === 'multidimensional-table') return <TableDocumentIcon className={className} />;
  if (kind === 'work-documents') return <MediaLibraryIcon className={className} />;
  return <FileKindIcon kind={kind} className={className} />;
}

/** Resolve a file's semantic icon kind through the shared content classifier. */
export function getFileIconKind(path: string, mimeType?: string | null): ContentFileIconKind {
  return classifyFileContent(path, mimeType);
}

export function NotebookTreeResourceIcon({ path, className, collectionType }: { path: string; className?: string; collectionType?: 'table' | 'media_library' | 'work_documents' }) {
  const legacyCollectionType = collectionType
    ?? (isTableDocumentPath(path) ? 'table' : /\.lib\.ya?ml$/i.test(path) ? 'media_library' : /\.workdocs\.ya?ml$/i.test(path) ? 'work_documents' : undefined);
  const content: ContentDescription = legacyCollectionType === 'table'
      ? { kind: 'multidimensional-table' }
      : legacyCollectionType === 'media_library'
        ? { kind: 'media-library' }
      : legacyCollectionType === 'work_documents'
        ? { kind: 'work-documents' }
      : { kind: 'file', path };
  return <ContentIcon content={content} className={className} />;
}

/**
 * 文件分类 → 图标的唯一分流：image / video / code 用自绘描边组件；
 * archive / text 自 2026-11 起不再有专属图形，与 unknown / fallback 一样
 * 统一渲染「空白折角纸页」（FallbackFileIcon）；其余查 ICON_BY_KIND。
 */
function FileKindIcon({ kind, className }: { kind: ContentFileIconKind; className?: string }) {
  if (kind === 'image') return <ImageFileIcon className={className} />;
  if (kind === 'video') return <VideoFileIcon className={className} />;
  if (kind === 'code') return <CodeFileIcon className={className} />;
  if (kind === 'archive' || kind === 'text' || kind === 'unknown' || kind === 'fallback') {
    return <FallbackFileIcon className={className} />;
  }
  const IconComponent = ICON_BY_KIND[kind];
  return <IconComponent aria-hidden="true" className={className} />;
}

function isTableDocumentPath(path: string): boolean {
  return /\.table\.ya?ml$/i.test(path);
}

function isWorkDocumentsCollectionPath(path: string): boolean {
  return /\.workdocs\.ya?ml$/i.test(path);
}

/**
 * 多维表格 (`.table.yaml`) 的统一图标 ── 与媒体库图标共用 viewBox、缩放、
 * 描边和透明度，保持文件树内视觉尺寸一致。保留 Phosphor 兼容组件
 * (forwardRef + IconProps), 以便直接作为 SlashMenuItem.icon 使用。
 */
export const TableDocumentIcon = forwardRef<SVGSVGElement, IconProps>(
  function TableDocumentIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
        <g transform="translate(1.5 1.5) scale(0.625)" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="18" x="2" y="3" rx="2" />
          <path d="M9 4v16M3 9h18" />
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
