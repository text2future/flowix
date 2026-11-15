import { Popover, PopoverContent } from '@shared/ui/popover';
import { PopupScrollArea } from '@shared/ui/popup-scroll-area';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Clock } from 'lucide-react';
import { notes as notesClient, type PathVersionMeta } from '@platform/tauri/client';
import { useI18n, translate, type AppLanguage, type I18nKey } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

type VersionDisplay = PathVersionMeta;
const logger = createLogger('document-version-history');

const VERSION_SOURCE_LABEL_KEYS: Record<PathVersionMeta['source'], I18nKey> = {
  auto: "document.version.source.auto",
  manual: "document.version.source.manual",
  restore_backup: "document.version.source.restoreBackup",
  cloud_conflict: "document.version.source.cloudConflict",
};

export function formatVersionTime(timestamp: number, language: AppLanguage): string {
  const intlLocale = language === "zh-CN" ? "zh-CN" : "en-US";
  // 英文用「June 24, 2025」简写形式 (long month + day + year, 无时间); 中文保留
  // 紧凑数字格式带时分, 列表项之间的时间信息更密。
  const options: Intl.DateTimeFormatOptions =
    language === "zh-CN"
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "long", day: "numeric" };
  return new Intl.DateTimeFormat(intlLocale, options).format(new Date(timestamp));
}

function formatVersionSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function VersionHistorySubmenu({
  notebookId,
  relativePath,
  refreshKey,
  restoringVersionId,
  onSelectVersion,
}: {
  notebookId: string;
  relativePath: string;
  refreshKey: number;
  restoringVersionId: string | null;
  onSelectVersion: (version: VersionDisplay) => void;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchorElement, setAnchorElement] = useState<HTMLButtonElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const keepOpen = () => { cancelClose(); setOpen(true); };
  const openFrom = (element: HTMLButtonElement) => { setAnchorElement(element); keepOpen(); };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); }, 120);
  };
  const [versions, setVersions] = useState<VersionDisplay[]>([]);
  const [loading, setLoading] = useState(false);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; cancelClose(); };
  }, [cancelClose]);

  useEffect(() => {
    if (!open) return;

    const requestSeq = ++requestSeqRef.current;
    setLoading(true);

    void notesClient.listVersions(notebookId, relativePath)
      .then((items) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        setVersions(items);
      })
      .catch((err) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        logger.error('list versions failed', { error: err, notebookId, relativePath });
        setOpen(false);
        toast.error(t("document.version.loadFailed"));
      })
      .finally(() => {
        if (mountedRef.current && requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      });
  }, [open, notebookId, relativePath, refreshKey, t]);

  const orderedVersions = useMemo(
    () => [...versions].sort((a, b) => b.createdAt - a.createdAt),
    [versions],
  );

  return (
    <Popover open={open} onOpenChange={setOpen} anchorElement={anchorElement}>
    <div className="relative" onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="group flex h-7 w-full cursor-pointer items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
        aria-expanded={open}
        aria-haspopup="dialog"
        onMouseEnter={(event) => openFrom(event.currentTarget)}
        onFocus={(event) => openFrom(event.currentTarget)}
      >
        <Clock className="h-4 w-4" />
        <span className="flex-1 text-left">{t("document.version.menuLabel")}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
      </button>

      <PopoverContent side="left" align="start" sideOffset={0} fitViewport scrollable={false}
        keepParentMenuOpen aria-label={t('document.version.allHistory')}
        onMouseEnter={keepOpen} onMouseLeave={scheduleClose}
        className="flex min-h-0 w-[300px] flex-col rounded-xl p-1 !z-[151] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <div
            className="flex items-center justify-between"
            style={{ padding: '0.15rem 0.375rem 0.35rem' }}
          >
            <div
              className="text-[var(--muted-foreground)]"
              style={{ fontSize: '0.75rem', lineHeight: 1.2 }}
            >
              {t("document.version.allHistory")}
            </div>
            <div className="text-[11px] text-[var(--muted-foreground)]">
              {orderedVersions.length}
            </div>
          </div>

          <PopupScrollArea className="max-h-[272px]" scrollerClassName="px-1">
            {loading && (
              <div className="flex items-center gap-1 px-2 py-3 text-xs text-[var(--muted-foreground)]">
                <Loader2 className="h-3.5 w-3.5 flowix-spin" />
                {t("document.version.loading")}
              </div>
            )}

            {!loading && orderedVersions.length === 0 && (
              <div className="px-2 py-3 text-xs text-[var(--muted-foreground)]">
                {t("document.version.empty")}
              </div>
            )}

            {!loading && orderedVersions.map((version) => {
              const isRestoring = restoringVersionId === version.id;
              return (
              <button
                key={version.id}
                type="button"
                disabled={isRestoring}
                onClick={() => {
                  setOpen(false);
                  onSelectVersion(version);
                }}
                className="group block w-full rounded-lg px-2 py-2 text-left hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-60"
                title={relativePath}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)] group-hover:text-[var(--foreground)]">
                    {formatVersionTime(version.createdAt, language)}
                  </span>
                  {isRestoring && (
                    <Loader2 className="h-3 w-3 flowix-spin text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
                  )}
                  <span className="rounded bg-[var(--background)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)] group-hover:bg-[var(--card)] group-hover:text-[var(--foreground)]">
                    {translate(language, VERSION_SOURCE_LABEL_KEYS[version.source] ?? "") || version.source}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
                  <span className="min-w-0 flex-1 truncate group-hover:text-[var(--foreground)]">
                    {relativePath}
                  </span>
                  <span className="shrink-0">{formatVersionSize(version.size)}</span>
                </div>
              </button>
            )})}
          </PopupScrollArea>
      </PopoverContent>
    </div>
    </Popover>
  );
}

