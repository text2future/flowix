import type { TableStyleId } from './table-presentation';

export function TableStyleIcon({ styleId, compact = false }: { styleId: TableStyleId; compact?: boolean }) {
  return (
    <svg className="shrink-0" viewBox="0 0 32 24" width={compact ? 20 : 26} height={compact ? 16 : 20}
      fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      {styleId === 'default' || styleId === 'literature' ? <>
        <rect x="3" y="3" width="26" height="18" rx={styleId === 'default' ? 1 : 0} />
        <path d="M3 9h26M3 15h26M13 3v18M21 3v18" />
        {styleId === 'literature' && <path d="M3 6h26M3 12h26M3 18h26" strokeOpacity="0.35" />}
      </> : <>
        <path d="M5 10h7M18 10h3M25 10h2M5 15h7M18 15h3M25 15h2M5 19h7M18 19h3M25 19h2" strokeOpacity="0.4" />
        {styleId === 'business-blue' && <><rect x="3" y="2" width="26" height="5" fill="currentColor" stroke="none" /><path d="M3 22h26" strokeWidth="3" strokeOpacity="0.3" /></>}
        {styleId === 'striped' && <><path d="M3 4h26M3 13h26M3 21h26" strokeWidth="5" strokeOpacity="0.18" /><path d="M3 7h26" /></>}
        {styleId === 'comparison' && <><rect x="16" y="3" width="7" height="19" fill="currentColor" fillOpacity="0.18" stroke="none" /><path d="M16 3h7M16 22h7M3 7h26" /></>}
        {styleId === 'financial-brief' && <path d="M3 3h26M3 7h26M3 17h26M3 21h26M3 23h26" />}
        {styleId === 'hk-financial' && <path d="M3 5h26M17 13h12M17 21h12M17 23h12" />}
        {styleId === 'three-line' && <><path d="M3 3h26M3 22h26" strokeWidth="2" /><path d="M3 7h26" /></>}
        {styleId === 'grouped' && <><path d="M3 3h26M3 22h26" /><path d="M3 7h26M3 17h26" strokeWidth="4" strokeOpacity="0.2" /></>}
        {styleId === 'minimal' && <path d="M3 7h26M3 13h26M3 18h26" strokeOpacity="0.45" strokeWidth="0.8" />}
      </>}
    </svg>
  );
}
