import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';

/** Lightweight table surface shown while the table renderer or document loads. */
export function MultidimensionalTableLoadingSkeleton({ showSpinner = false }: { showSpinner?: boolean }) {
  const widths = ['w-2/3', 'w-1/2', 'w-3/5', 'w-2/5'];
  return <div className="relative h-full min-h-0 overflow-hidden" aria-label="多维表格预览" aria-busy="true">
    <div className="h-full overflow-hidden p-5" aria-hidden="true">
      <table className="multidimensional-table w-full min-w-[640px] table-fixed border-collapse text-sm">
        <thead><tr>{widths.map((width, index) => <th key={index} className="h-10 border-r border-[var(--border)] px-2 text-left">
          <div className={`h-3 animate-pulse rounded bg-[var(--muted)] opacity-[0.36] ${width}`} />
        </th>)}</tr></thead>
        <tbody>{Array.from({ length: 7 }, (_, row) => <tr key={row}>{['w-3/4', 'w-1/2', 'w-2/3', 'w-1/3'].map((width, column) => <td key={column} className="h-10 border-b border-r border-[var(--border)] px-2">
          <div className={`h-3 animate-pulse rounded bg-[var(--muted)] opacity-[0.36] ${width}`} />
        </td>)}</tr>)}</tbody>
      </table>
    </div>
    {showSpinner && <CenteredLoadingSpinner className="pointer-events-none absolute inset-0" ariaLabel="正在打开多维表格" />}
  </div>;
}
