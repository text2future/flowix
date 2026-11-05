import { Fragment } from 'react';
import { Check, ChevronRight, Ellipsis, Globe, Palette } from 'lucide-react';
import { LinkSimpleIcon, FolderOpenIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@shared/ui/dropdown-menu';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { CollectionDisplayMenuItems } from '@features/collection/public/header-api';
import { Tooltip } from '@shared/ui/tooltip';
import { NOTE_COLORS, NOTE_COLOR_HEX } from '@features/memo/store/note-store';
import type { NoteColor } from '@/types/note-item';
import { useI18n, translate, type AppLanguage, type I18nKey } from '@/lib/i18n';
import type { DocumentTitlebarProps, DocumentTitlebarTarget } from './document-titlebar-model';

export function ExternalTitlebarBadge({ target }: { target: DocumentTitlebarTarget }) {
  const { t } = useI18n();
  if (!target.isOutsideCurrentNotebook) return null;
  return <span className="shrink-0 whitespace-nowrap pl-3 text-xs text-[var(--muted-foreground)]"
    aria-label={t('document.external.titlebarBadge')}>{t('document.external.titlebarBadge')}</span>;
}

export function ExternalPathDisplay({ path }: { path: string }) {
  // Split "/Users/rop/.../file.md" into segments and drop the leading empty
  // entry from the leading slash. Trailing/duplicate slashes are also dropped
  // by filter(Boolean).
  const segments = path.split('/').filter(Boolean);

  return (
    <div className="w-fit max-w-full min-w-0 pl-3" title={path}>
      <div className="flex items-center overflow-hidden text-xs text-[var(--foreground)]">
        {segments.map((segment, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <ChevronRight
                aria-hidden="true"
                className="mx-1 h-3 w-3 shrink-0 text-[var(--muted-foreground)]"
              />
            )}
            <span className="shrink-0">{segment}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function SurfaceHeaderIcon({ icon, web = false }: { icon?: string | null; web?: boolean }) {
  if (web) {
    const imageSource = icon && (/^https?:\/\//i.test(icon)
      || (icon.length <= 64 * 1024 && /^data:image\/(?:svg\+xml|png|jpe?g|gif|webp|avif)(?:;[^,]*)?,/i.test(icon))) ? icon : null;
    return <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
      <Globe aria-hidden="true" className="h-3.5 w-3.5" />
      {imageSource && <img key={imageSource} src={imageSource} alt=""
        className="absolute h-3.5 w-3.5 rounded-sm object-contain"
        onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
    </span>;
  }
  if (!icon) return null;
  if (icon.startsWith('http://') || icon.startsWith('https://')) {
    return <img src={icon} alt="" className="h-4 w-4 shrink-0 rounded-sm object-contain" />;
  }
  return <span aria-hidden="true" className="shrink-0 text-sm leading-none">{icon}</span>;
}

// =====================================================================
// Memo color picker — multi-select, dropdown of 7 swatches
// 触发按钮:
//   - 空数组 (无颜色) 时显示 `Palette` 图标
//   - 至少 1 个颜色时显示叠加的小圆点 (右上偏移, 制造"多色"的视觉密度)
// 7 个色块 + 1 个 "无" 按钮: 点色块 toggle, 点 "无" 清空全部。 每次切换
// 把整组新颜色走 `onChange` 一次性写回后端；行内状态即时更新，路径通知刷新查询投影。
// =====================================================================

const COLOR_LABEL_KEYS: Record<NoteColor, I18nKey> = {
  red: "document.color.red",
  orange: "document.color.orange",
  yellow: "document.color.yellow",
  green: "document.color.green",
  cyan: "document.color.cyan",
  blue: "document.color.blue",
  gray: "document.color.gray",
};

function getColorLabel(color: NoteColor, language: AppLanguage): string {
  return translate(language, COLOR_LABEL_KEYS[color]);
}

export function NoteColorPicker({
  colors,
  iconButtonClass,
  onChange,
}: {
  colors: NoteColor[];
  iconButtonClass: string;
  onChange: (next: NoteColor[]) => void;
}) {
  const { t, language } = useI18n();
  const selected = new Set(colors);

  const toggle = (c: NoteColor) => {
    const next = new Set(selected);
    if (next.has(c)) {
      next.delete(c);
    } else {
      next.add(c);
    }
    // 保持 NOTE_COLORS 声明顺序, 列表 / 触发按钮展示稳定。
    onChange(NOTE_COLORS.filter((c) => next.has(c)));
  };

  const clear = () => onChange([]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tooltip content={t("document.color.tooltip")}>
          <button
            type="button"
            aria-label={t("document.color.button")}
            className={iconButtonClass}
          >
            {colors.length > 0 ? (
              <span aria-hidden="true" className="relative block h-3.5 w-3.5">
                {colors.slice(0, 3).map((c, i) => (
                  <span
                    key={c}
                    className="absolute h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor: NOTE_COLOR_HEX[c],
                      top: colors.length === 1 ? '2px' : `${(i % 2) * 4}px`,
                      left: colors.length === 1 ? '2px' : `${(i % 2) * 4}px`,
                      zIndex: 10 - i,
                    }}
                  />
                ))}
              </span>
            ) : (
              <Palette className="w-4 h-4" />
            )}
          </button>
        </Tooltip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[180px] rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      >
        <div className="flex items-center gap-1.5">
          <Tooltip content={t("document.color.noColorTooltip")}>
            <button
              type="button"
              aria-label={t("document.color.clear")}
              onClick={clear}
              className={`relative h-7 w-7 rounded-md border bg-transparent transition-colors ${
                colors.length === 0
                  ? 'border-[var(--muted-foreground)]'
                  : 'border-[var(--border)] hover:border-[var(--muted-foreground)]'
              }`}
            />
          </Tooltip>
          {NOTE_COLORS.map((c) => {
            const isSelected = selected.has(c);
            return (
              <button
                key={c}
                type="button"
                aria-label={getColorLabel(c, language)}
                aria-pressed={isSelected}
                onClick={() => toggle(c)}
                className="relative h-7 w-7 rounded-md transition-transform hover:scale-110"
                style={{ backgroundColor: NOTE_COLOR_HEX[c] }}
              >
                {isSelected && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 flex items-center justify-center text-white opacity-70"
                  >
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MediaActions({
  iconButtonClass,
  collectionDisplay,
  onCopyLink,
  onRevealInFileManager,
  onRequestDelete,
}: {
  iconButtonClass: string;
  collectionDisplay?: DocumentTitlebarProps['collectionDisplay'];
  onCopyLink: () => void | Promise<void>;
  onRevealInFileManager: () => void;
  onRequestDelete?: () => void;
}) {
  const { t } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tooltip content={t('media.action.other')}>
          <button
            type="button"
            aria-label={t('media.action.other')}
            title={t('media.action.other')}
            className={iconButtonClass}
          >
            <Ellipsis className="h-4 w-4" />
          </button>
        </Tooltip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        {collectionDisplay && <>
          <CollectionDisplayMenuItems {...collectionDisplay} />
          <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
        </>}
        <DropdownMenuItem
          onClick={() => { void onCopyLink(); }}
          className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
        >
          <LinkSimpleIcon className="h-4 w-4" />
          {t('document.action.copyLink')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={onRevealInFileManager}
          className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
        >
          <FolderOpenIcon className="h-4 w-4" />
          {t('memo.fileTree.reveal')}
        </DropdownMenuItem>
        {onRequestDelete && <>
          <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
          <DropdownMenuItem
            onClick={onRequestDelete}
            className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-transparent hover:text-[var(--destructive)]"
          >
            <TrashSimpleIcon className="h-4 w-4" />
            {t('media.fileTree.delete')}
          </DropdownMenuItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
