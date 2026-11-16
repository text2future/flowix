import type { CSSProperties } from 'react';
import { canonicalPath } from '@/lib/path';
import { ContentIcon, type ContentKind } from '@features/content/public/content-api';

/** Stable path keys preserve cards as the selection spreads into a fan. */
export function ColumnSelectionView({ paths, label, contentKinds }: {
  paths: readonly string[];
  label: string;
  contentKinds?: ReadonlyMap<string, ContentKind>;
}) {
  const visiblePaths = paths.slice(0, 15);
  const halfSpread = Math.min(22, (visiblePaths.length - 1) * 6);
  return (
    <section className="column-selection-view" aria-label={label}>
      <div className="column-selection-summary">
        <ul className="column-selection-fan">
          {visiblePaths.map((path, index) => {
            const normalizedPath = canonicalPath(path);
            const fileName = normalizedPath.split('/').pop() || normalizedPath;
            const name = fileName.replace(/(?:\.index\.yaml|\.md)$/i, '');
            const contentKind = contentKinds?.get(normalizedPath);
            const position = visiblePaths.length > 1 ? (index / (visiblePaths.length - 1)) * 2 - 1 : 0;
            const style = {
              '--fan-position': position * halfSpread / 22,
              '--fan-angle': `${position * halfSpread}deg`,
              '--fan-drop': `${Math.abs(position) * 20}px`,
              zIndex: index,
            } as CSSProperties;
            return (
              <li key={normalizedPath} className="column-selection-slot" style={style} title={path}>
                <div className="column-selection-card">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--muted)] text-[var(--muted-foreground)]" aria-hidden="true">
                    <ContentIcon content={contentKind ? { kind: contentKind } : { kind: 'file', path }} className="h-7 w-7" />
                  </div>
                  <span className="line-clamp-2 break-words text-sm font-medium text-[var(--foreground)]">{name}</span>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-[var(--muted-foreground)]" role="status">{label}</p>
      </div>
    </section>
  );
}
