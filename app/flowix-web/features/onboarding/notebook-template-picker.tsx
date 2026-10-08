import { useMemo, useState } from 'react';
import { Check, CircleAlert, Plus, X } from 'lucide-react';
import { ArrowsLeftRightIcon } from '@phosphor-icons/react';
import { Button } from '@shared/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { NotebookTemplate } from './notebook-templates';
import type { NotebookTemplateLoadStatus } from './notebook-templates';
import { NotebookTemplateCategories } from './notebook-template-categories';
import { NotebookTemplateCover } from './notebook-template-icon';

function NotebookTemplateCardContent({
  template,
  onSwitch,
}: {
  template: NotebookTemplate;
  onSwitch?: () => void;
}) {
  return (
    <>
      <span className="group/cover relative block min-w-0">
        <NotebookTemplateCover template={template} />
        {template.coverUrl && onSwitch && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg bg-[color-mix(in_oklch,var(--background)_68%,transparent)] opacity-0 transition-opacity group-hover/cover:pointer-events-auto group-hover/cover:opacity-100 group-focus-within/cover:pointer-events-auto group-focus-within/cover:opacity-100">
            <button
              type="button"
              aria-label="切换场景模板"
              title="切换场景模板"
              className="inline-flex h-7 w-7 items-center justify-center text-[var(--brand)]"
              onClick={onSwitch}
            >
              <ArrowsLeftRightIcon size={28} weight="bold" aria-hidden="true" />
            </button>
          </span>
        )}
      </span>
      <span className="grid min-w-0 content-start gap-1">
        <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-base font-medium tracking-[-0.015em] text-[var(--onboarding-ink)]">{template.name}</strong>
        <small className="line-clamp-2 overflow-hidden text-sm leading-[1.5] text-[var(--onboarding-subtle)]">{template.description}</small>
      </span>
    </>
  );
}

export function NotebookTemplateCardPreview({
  template,
  onSwitch,
}: {
  template: NotebookTemplate;
  onSwitch: () => void;
}) {
  return (
    <div className="grid min-h-0 w-[min(280px,100%)] grid-rows-[auto_auto] gap-2 rounded-[11px] border border-[var(--onboarding-line)] bg-[var(--card)] p-[10px] text-left text-[var(--onboarding-subtle)]">
      <NotebookTemplateCardContent template={template} onSwitch={onSwitch} />
    </div>
  );
}

export function NotebookTemplateEmptyCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex h-[240px] w-[320px] max-w-full flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-[color-mix(in_oklch,var(--onboarding-line)_90%,var(--onboarding-ink))] bg-transparent text-sm text-[var(--onboarding-subtle)]"
      aria-haspopup="dialog"
      onClick={onClick}
    >
      <Plus size={18} aria-hidden="true" />
      <span>选择场景模板</span>
    </button>
  );
}

export function NotebookTemplatePicker({
  templates,
  status,
  retry,
  initialTemplateId,
  onCancel,
  onComplete,
}: {
  templates: NotebookTemplate[];
  status: NotebookTemplateLoadStatus;
  retry: () => void;
  initialTemplateId: string | null;
  onCancel: () => void;
  onComplete: (templateId: string | null) => void;
}) {
  const { t } = useI18n();
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialTemplateId);
  const [selectedCategory, setSelectedCategory] = useState('');
  const visibleTemplates = useMemo(() => (
    selectedCategory
      ? templates.filter((template) => template.category === selectedCategory)
      : templates
  ), [selectedCategory, templates]);

  return (
    <div className="absolute inset-0 z-[5] grid grid-rows-[minmax(0,1fr)_auto] bg-[var(--frame-bg)] text-[var(--onboarding-ink)] [--onboarding-ink:var(--foreground)] [--onboarding-subtle:var(--muted-foreground)] [--onboarding-panel:color-mix(in_oklch,var(--card)_96%,var(--background))] [--onboarding-line:color-mix(in_oklch,var(--border)_78%,transparent)]" role="dialog" aria-modal="true" aria-label="选择场景模板">
      <main className="overflow-auto px-[clamp(20px,5vw,64px)] pb-7 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="sticky top-0 z-[3] flex items-center gap-3 bg-[var(--frame-bg)] pb-2 shadow-[0_1px_0_var(--onboarding-line)]">
          <NotebookTemplateCategories
            templates={templates}
            value={selectedCategory}
            onChange={setSelectedCategory}
          />
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--muted-foreground)] shadow-sm transition-colors hover:border-[color-mix(in_oklch,var(--border)_65%,var(--muted-foreground))] hover:text-[var(--foreground)]"
            aria-label="关闭场景选择"
            onClick={onCancel}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        {status === 'loading' && (
          <p className="mt-4 text-sm text-muted-foreground" aria-live="polite">
            {t('notebook.template.loading')}
          </p>
        )}
        {status === 'error' && (
          <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-[var(--destructive)]" role="alert">
            <CircleAlert size={15} aria-hidden="true" />
            <span>{t('notebook.template.loadFailed')}</span>
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={retry}>
              {t('error.retry')}
            </Button>
          </div>
        )}
        {status === 'ready' && templates.length === 0 && (
          <p className="mt-4 text-sm text-muted-foreground">{t('notebook.template.empty')}</p>
        )}
        <div className="mt-[18px] grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-3 max-[600px]:grid-cols-2 max-[600px]:gap-2" role="group" aria-label="场景模板">
          {visibleTemplates.map((template) => {
            const selected = template.id === selectedTemplateId;
            return (
              <button
                key={template.id}
                type="button"
                aria-pressed={selected}
                className={cn(
                  'relative grid min-h-0 min-w-0 content-start grid-rows-[auto_auto] gap-2 rounded-[11px] border border-[var(--onboarding-line)] bg-[color-mix(in_oklch,var(--onboarding-panel)_74%,transparent)] p-[11px] text-left text-[var(--onboarding-subtle)] transition-colors hover:border-[color-mix(in_oklch,var(--brand)_45%,var(--onboarding-line))] max-[600px]:p-2',
                  selected && 'border-[color-mix(in_oklch,var(--brand)_55%,var(--border))] bg-[var(--card)]',
                )}
                onClick={() => setSelectedTemplateId((current) => current === template.id ? null : template.id)}
              >
                <NotebookTemplateCardContent template={template} />
                {selected && (
                  <span
                    className="pointer-events-none absolute inset-0 z-[1] grid place-items-center rounded-[inherit] bg-[color-mix(in_oklch,var(--background)_68%,transparent)]"
                    aria-hidden="true"
                  >
                    <Check size={32} className="text-[var(--brand)]" strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </main>

      <footer className="flex justify-end gap-2 border-t border-[var(--onboarding-line)] bg-[var(--frame-bg)] px-[clamp(20px,5vw,64px)] pb-[calc(14px+env(safe-area-inset-bottom))] pt-[14px]">
        <button type="button" className="inline-flex h-8 min-h-8 items-center justify-center gap-2 rounded-lg border border-[var(--onboarding-line)] px-[15px] text-xs font-medium text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)]" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="inline-flex h-8 min-h-8 items-center justify-center gap-2 rounded-lg border border-[var(--brand)] bg-[var(--brand)] px-[15px] text-xs font-semibold text-[var(--primary-foreground)] shadow-[0_8px_18px_color-mix(in_oklch,var(--brand)_18%,transparent)] transition-transform hover:-translate-y-px"
          onClick={() => onComplete(selectedTemplateId)}
        >
          完成
        </button>
      </footer>
    </div>
  );
}
