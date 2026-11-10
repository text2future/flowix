'use client';

/** Shared collection header menu: display preferences and content commands. */
import { Ellipsis } from 'lucide-react';
import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { useCollectionTitleVisibility } from '@/lib/collection-title-visibility';
import { useCollectionBannerControl } from '@/lib/collection-banner-visibility';

export interface CollectionDisplayMenuProps {
  /** 集合体地址（`<folder>/.index.yaml`）：头图开关按它找登记项。 */
  indexPath: string;
  /** 与 header 其它图标按钮同一套描边/圆角，由调用方给（mac / windows 两种）。 */
  iconButtonClass: string;
  notebookPath?: string | null;
  notebookId?: string | null;
}

const ITEM_CLASS = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]';

/** Collection display commands shared by every header menu. */
export function CollectionDisplayMenuItems({ indexPath }: Omit<CollectionDisplayMenuProps, 'iconButtonClass'>) {
  const { t } = useI18n();
  const { titleVisible, toggleTitleVisibility } = useCollectionTitleVisibility();
  const banner = useCollectionBannerControl(indexPath);

  return <>
    <DropdownMenuItem onClick={toggleTitleVisibility} className={ITEM_CLASS}>
      {titleVisible
        ? <EyeIcon size={16} weight="bold" className="shrink-0 text-[var(--brand)]" aria-hidden="true" />
        : <EyeSlashIcon size={16} weight="bold" className="shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />}
      <span className="flex-1">{t('collection.display.title')}</span>
    </DropdownMenuItem>
    {banner.available ? <DropdownMenuItem onClick={banner.toggle} className={ITEM_CLASS}>
      {banner.visible
        ? <EyeIcon size={16} weight="bold" className="shrink-0 text-[var(--brand)]" aria-hidden="true" />
        : <EyeSlashIcon size={16} weight="bold" className="shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />}
      <span className="flex-1">{t('collection.display.banner')}</span>
    </DropdownMenuItem> : null}
  </>;
}

export function CollectionDisplayMenu({ indexPath, iconButtonClass }: CollectionDisplayMenuProps) {
  const { t } = useI18n();

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className={`${iconButtonClass} [-webkit-app-region:no-drag]`}
        aria-label={t('collection.display.more')}
        title={t('collection.display.more')}
      >
        <Ellipsis className="h-4 w-4" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <CollectionDisplayMenuItems indexPath={indexPath} />
    </DropdownMenuContent>
  </DropdownMenu>;
}
