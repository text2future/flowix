'use client';

import {
  BookOpen,
  ChartLine,
  Code2,
  FolderOpen,
  GraduationCap,
  Link2,
  PenLine,
  Sparkles,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { useI18n } from '@/lib/i18n';

const featureItems = [
  { key: 'workspace', icon: BookOpen },
  { key: 'library', icon: FolderOpen },
  { key: 'links', icon: Link2 },
  { key: 'pi', icon: Sparkles },
  { key: 'development', icon: Code2, caseStudy: true },
  { key: 'fiction', icon: PenLine, caseStudy: true },
  { key: 'investment', icon: ChartLine, caseStudy: true },
  { key: 'teaching', icon: GraduationCap, caseStudy: true },
] as const;

interface ProductIntroDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProductIntroDialog({ open, onOpenChange }: ProductIntroDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-none !rounded-2xl !border !border-[var(--border-popup)] !bg-[var(--card)] !p-0 shadow-[0_16px_64px_-12px_rgb(0_0_0_/_0.35)] w-[calc(100vw-2rem)] sm:w-[60vw] h-[min(84vh,900px)] overflow-hidden">
        <OverlayScrollbar className="h-full w-full" scrollerClassName="h-full">
          <div className="relative overflow-hidden bg-[linear-gradient(125deg,color-mix(in_oklch,var(--primary)_12%,var(--card)),var(--card)_58%)] px-7 pb-7 pt-8 sm:px-10 sm:pb-9 sm:pt-10">
            <div aria-hidden="true" className="absolute -right-10 -top-20 h-64 w-64 rounded-full bg-[color-mix(in_oklch,var(--primary)_10%,transparent)] blur-3xl" />
            <div className="relative max-w-3xl">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[color-mix(in_oklch,var(--primary)_24%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_7%,var(--card))] px-2 py-1.5 text-xs font-medium text-[var(--primary)]">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {t('shell.productIntro.eyebrow')}
              </div>
              <DialogHeader className="mb-0">
                <DialogTitle className="text-2xl font-semibold tracking-tight text-[var(--foreground)] sm:text-3xl">
                  {t('shell.productIntro.title')}
                </DialogTitle>
                <DialogDescription className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted-foreground)] sm:text-base sm:leading-7">
                  {t('shell.productIntro.description')}
                </DialogDescription>
              </DialogHeader>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 sm:gap-4 sm:p-7 lg:p-9">
            {featureItems.map((item, index) => {
              const { key, icon: Icon } = item;
              const caseStudy = 'caseStudy' in item && item.caseStudy;
              return (
                <section
                  key={key}
                  className="group relative min-h-36 overflow-hidden rounded-xl border border-[var(--border)] bg-[color-mix(in_oklch,var(--background)_54%,var(--card))] p-5 transition-colors hover:bg-[color-mix(in_oklch,var(--primary)_3%,var(--card))] sm:p-6"
                >
                  <span aria-hidden="true" className={`absolute right-4 ${caseStudy ? 'top-12' : 'top-2'} select-none text-5xl font-semibold tracking-tighter text-[color-mix(in_oklch,var(--muted-foreground)_8%,transparent)]`}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  {caseStudy && (
                    <span className="absolute right-4 top-4 rounded-full border border-[color-mix(in_oklch,var(--primary)_24%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_8%,var(--card))] px-2 py-0.5 text-[10px] font-medium text-[var(--primary)]">
                      {t('shell.productIntro.caseTag')}
                    </span>
                  )}
                  <div className="relative">
                    <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_10%,var(--card))] text-[var(--primary)]">
                      <Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
                    </div>
                    <h3 className="text-sm font-semibold text-[var(--foreground)] sm:text-base">
                      {t(`shell.productIntro.${key}.title`)}
                    </h3>
                    <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)] sm:text-sm sm:leading-6">
                      {t(`shell.productIntro.${key}.description`)}
                    </p>
                  </div>
                </section>
              );
            })}
          </div>

          <div className="px-5 pb-6 sm:px-7 sm:pb-8 lg:px-9">
            <div className="flex items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_6%,var(--card))] px-4 py-3.5 text-center text-xs leading-5 text-[var(--muted-foreground)] sm:px-5 sm:text-sm">
              <span>{t('shell.productIntro.footer')}</span>
            </div>
          </div>
        </OverlayScrollbar>
      </DialogContent>
    </Dialog>
  );
}
