import { useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { MapPinSimpleAreaIcon } from '@phosphor-icons/react';
import { canonicalPath, notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { DropdownMenuItem } from '@shared/ui/dropdown-menu';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { useCollectionSummary } from './use-collection-summary';
import { useDefaultCreateFolder } from './use-default-create-folder';
import { addCollectionDomain } from './folder-collection';
import type { CollectionDomain } from './model';

/** Collection commands depend on the collection address and notebook, never its container. */
export function CollectionContentMenuItems({ indexPath, notebookPath, notebookId }: {
  indexPath: string; notebookPath: string; notebookId: string;
}) {
  const { t } = useI18n();
  const [summary, setSummary] = useCollectionSummary(indexPath, notebookPath, notebookId);
  const { defaultCreateFolderState, handleToggleDefaultFolder } = useDefaultCreateFolder({ id: notebookId, path: notebookPath });
  const [saving, setSaving] = useState(false);
  if (!summary || summary === 'missing' || !canonicalPath(indexPath).endsWith('/.index.yaml')) return null;
  const folder = notebookRelativeDirectoryPath(notebookPath, parentDirectoryPath(indexPath, notebookPath));
  if (folder === null) return null;
  const isDefaultFolder = defaultCreateFolderState?.notebookId === notebookId && defaultCreateFolderState.path === folder;
  const addDomain = async (domain: CollectionDomain) => {
    if (saving || summary.domains.includes(domain)) return;
    setSaving(true);
    try { setSummary(await addCollectionDomain(indexPath, notebookPath, domain)); }
    catch (error) { toast.error(error instanceof Error ? error.message : '添加集合内容失败'); }
    finally { setSaving(false); }
  };
  return <>
    <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
    {([['notes', '展示笔记'], ['media', '展示图/视频']] as const).map(([domain, label]) => <DropdownMenuItem
      key={domain} disabled={saving || summary.domains.includes(domain)}
      onClick={() => void addDomain(domain)}>
      {summary.domains.includes(domain) ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
      {label}
    </DropdownMenuItem>)}
    <DropdownMenuItem disabled={defaultCreateFolderState?.notebookId !== notebookId}
      onClick={() => void handleToggleDefaultFolder({ filePath: indexPath, notebookPath, notebookId })}>
      <MapPinSimpleAreaIcon className="h-4 w-4" />
      {t(isDefaultFolder ? 'memo.fileTree.clearDefaultCreateFolder' : 'memo.fileTree.setDefaultCreateFolder')}
    </DropdownMenuItem>
  </>;
}
