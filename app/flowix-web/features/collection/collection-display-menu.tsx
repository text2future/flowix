'use client';

/**
 * 集合显示菜单 ── Work 列顶部 header 右侧的「···」。
 *
 * 只放**显示开关**，与内容/视图无关：
 *   - 显示标题：全局偏好（`useCollectionTitleVisibility`），与 tab 条「···」同一条；
 *   - 显示头图：集合属性 `banner_hidden`，通过 `useCollectionBannerControl` 交给
 *     持有 summary 的集合外壳去写（本组件不读集合文件）。
 *
 * 眼睛图标即当前状态：开 → `EyeIcon`（品牌色），关 → `EyeSlashIcon`（弱化）。
 * 集合还没挂载外壳（如工作文档视图）时没有头图入口，只留「显示标题」。
 */
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
}

const ITEM_CLASS = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]';

/** Display preferences shared by the standalone folder menu and collection file action menus. */
export function CollectionDisplayMenuItems({ indexPath }: Pick<CollectionDisplayMenuProps, 'indexPath'>) {
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
