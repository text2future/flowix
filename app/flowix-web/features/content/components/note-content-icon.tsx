import type { SVGProps } from 'react';

import { cn } from '@/lib/utils';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Shared path data keeps React icons and imperative NodeViews identical. */
const NOTE_CONTENT_ICON_PATHS = [
  {
    className: 'note-icon__paper',
    opacity: '0.14',
    transform: 'translate(1.66666 0.999997)',
    d: 'M12.6667 6.4526C12.6667 5.6429 12.6667 5.2381 12.5171 4.8733C12.3675 4.5086 12.0832 4.2204 11.5146 3.6439L9.0958 1.1912C8.5163 0.6036 8.2265 0.3098 7.8562 0.1549C7.4858 0 7.0732 0 6.2478 0L4.6667 0C2.4759 0 1.3737 -0.0068 0.6834 0.6834C-0.0068 1.3737 0 2.4759 0 4.6667L0 9.3333C0 11.5241 -0.0068 12.6263 0.6834 13.3166C1.3737 14.0068 2.4759 14 4.6667 14L8 14C10.1908 14 11.293 14.0068 11.9832 13.3166C12.6735 12.6263 12.6667 11.5241 12.6667 9.3333L12.6667 6.4526Z',
  },
  {
    className: 'note-icon__fold',
    opacity: '0.22',
    transform: 'translate(6.4668 1)',
    d: 'M7.8649 5.4766C7.8617 5.3089 7.8522 5.1927 7.8257 5.0811C7.7894 4.9289 7.7297 4.783 7.6484 4.6491C7.5568 4.4979 7.4287 4.368 7.1724 4.1081L3.8289 0.7179C3.5677 0.453 3.437 0.3205 3.284 0.2257C3.1486 0.1419 3.0005 0.0799 2.8455 0.0423C2.6707 0 2.4847 0 2.1126 0L0 0L0 0.0067L1.5067 0.0067L1.5272 0.0067C2.2209 0.0067 2.5719 0.0067 2.7926 0.2274C3.0133 0.4479 3.0133 0.7992 3.0133 1.4928L3.0133 1.5133L3.0133 1.89L3.0133 1.9312C3.0133 3.3185 3.0133 4.0207 3.4546 4.4621C3.896 4.9033 4.5981 4.9033 5.9855 4.9033L6.0267 4.9033L6.4033 4.9033L6.4238 4.9033C7.1175 4.9033 7.4688 4.9033 7.6893 5.124C7.7799 5.2145 7.8333 5.3271 7.8649 5.4766Z',
  },
  {
    className: 'note-icon__mark',
    opacity: '0.55',
    transform: 'translate(4.61003 7.24626)',
    d: 'M0 1.2147C0 0.5622 0.5145 0.0299 1.1599 0.0012C1.1667 0.0008 1.1737 0.0005 1.1806 0.0005C1.192 0.0002 1.2033 0 1.2147 0L1.2147 0.0008C1.6818 0.0124 2.0994 0.2985 2.2781 0.7322L3.39 3.431L4.5019 0.7322C4.6806 0.2985 5.0982 0.0124 5.5653 0.0008L5.5653 0C5.5767 0 5.588 0.0002 5.5994 0.0005C5.6063 0.0005 5.6133 0.0008 5.6201 0.0012C6.2655 0.0299 6.78 0.5622 6.78 1.2147L6.78 5.65C6.1091 5.65 5.5652 5.1061 5.5653 4.4353L5.5653 1.3824L4.2246 4.2297C4.106 4.4815 3.8904 4.6677 3.6346 4.7522C3.5842 4.7839 3.5242 4.8025 3.4582 4.8025C3.4353 4.8025 3.4126 4.8017 3.39 4.8002C3.3674 4.8017 3.3447 4.8025 3.3218 4.8025C3.2558 4.8025 3.1958 4.7839 3.1454 4.7522C2.8896 4.6677 2.674 4.4815 2.5554 4.2297L1.2147 1.3824L1.2147 4.4353C1.2148 5.1061 0.6709 5.65 0 5.65L0 1.2147Z',
  },
] as const;

/** Create the shared note icon for imperative DOM surfaces such as ProseMirror NodeViews. */
export function createNoteContentIconElement({
  width = 64,
  height = 64,
  className,
}: { width?: number; height?: number; className?: string } = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('xmlns', SVG_NAMESPACE);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cn('note-content-icon', className));
  const group = document.createElementNS(SVG_NAMESPACE, 'g');
  group.setAttribute('transform', 'translate(1 1)');
  for (const definition of NOTE_CONTENT_ICON_PATHS) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('class', definition.className);
    path.setAttribute('opacity', definition.opacity);
    path.setAttribute('transform', definition.transform);
    path.setAttribute('d', definition.d);
    group.append(path);
  }
  svg.append(group);
  return svg;
}

/**
 * Notebook note icon: folded paper with a centered Markdown mark.
 * Geometry is shared with createNoteContentIconElement and dark theme
 * compensation lives in styles/note-content-icon.css.
 */
export function NoteContentIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns={SVG_NAMESPACE}
      width="64"
      height="64"
      viewBox="0 0 18 18"
      fill="currentColor"
      aria-hidden="true"
      className={cn('note-content-icon', className)}
      {...props}
    >
      <g transform="translate(1 1)">
        {NOTE_CONTENT_ICON_PATHS.map(({ className: pathClass, opacity, transform, d }) => (
          <path key={pathClass} className={pathClass} opacity={opacity} transform={transform} d={d} />
        ))}
      </g>
    </svg>
  );
}
