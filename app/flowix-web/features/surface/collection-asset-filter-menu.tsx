import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { files } from '@platform/tauri/client';
import { parseHybridCollection } from '@features/collection/public/hybrid-api';
import { assetConditionFromFilter, setCollectionAssetFilter, type AssetFilterCondition } from '@features/collection/public/folder-api';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { useDatasetFilter } from './use-dataset-filter';

/** Edit the collection's shared asset conditions without replacing the note menu. */
export function CollectionAssetFilterMenu({ source, indexPath, notebookPath, editable }: {
  source?: string; indexPath: string; notebookPath: string; editable: boolean;
}) {
  const { t } = useI18n();
  const [condition, setCondition] = useState<AssetFilterCondition>({});
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setReady(false);
    void (source ? Promise.resolve(source) : files.read(indexPath, notebookPath)).then((source) => {
      if (!active || source === null) return;
      const domains = parseHybridCollection(source).payload.domains;
      const dataset = domains.media ?? domains.work_documents;
      const storedFilter = dataset?.filter;
      setCondition(assetConditionFromFilter(storedFilter && typeof storedFilter === 'object' && !Array.isArray(storedFilter)
        ? storedFilter as Record<string, unknown> : undefined));
      setReady(true);
    }).catch((error) => { if (active) toast.error(String(error)); });
    return () => { active = false; };
  }, [source, indexPath, notebookPath]);
  const filter = useDatasetFilter({ condition, notebookPath, busy,
    onChange: editable ? async (next, options) => {
      setBusy(true);
      try {
        await setCollectionAssetFilter(indexPath, notebookPath, next, options);
        setCondition(next);
        return true;
      } catch (error) {
        toast.error(String(error));
        return false;
      } finally { setBusy(false); }
    } : undefined,
  });
  return <Popover open={filter.open} onOpenChange={filter.onMenuOpenChange}>
    <PopoverTrigger asChild><button type="button" disabled={!ready || !editable || busy}
      className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
      <span>{t('collection.filter.assets')}</span><ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
    </button></PopoverTrigger>
    <PopoverContent side="left" align="start" sideOffset={0} fitViewport style={{ zIndex: 160 }} keepParentMenuOpen ignorePopoverOutside ignoreSelectOutside
      className="max-h-[min(70vh,420px)] w-[320px] overflow-y-auto rounded-xl p-1.5">
      {filter.renderPanel(false)}
    </PopoverContent>
  </Popover>;
}
