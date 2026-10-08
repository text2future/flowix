import type { NotebookTemplate } from './notebook-templates';

export function getNotebookTemplateCategoryNames(templates: NotebookTemplate[]): string[] {
  return [...new Set(templates.map((template) => template.category).filter((category): category is string => Boolean(category)))];
}

export function NotebookTemplateCategories({
  templates,
  value,
  onChange,
}: {
  templates: NotebookTemplate[];
  value: string;
  onChange: (category: string) => void;
}) {
  const counts = new Map<string, number>();
  for (const template of templates) {
    if (template.category) counts.set(template.category, (counts.get(template.category) ?? 0) + 1);
  }
  const categories = getNotebookTemplateCategoryNames(templates);

  return (
    <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto p-0 [scrollbar-width:thin]" role="group" aria-label="场景分类">
      <button
        type="button"
        className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--onboarding-line)] bg-[color-mix(in_oklch,var(--onboarding-panel)_74%,transparent)] px-[9px] text-sm text-[var(--onboarding-subtle)] hover:border-[color-mix(in_oklch,var(--brand)_55%,var(--border))] hover:bg-[var(--card)] hover:text-[var(--onboarding-ink)] aria-pressed:border-[color-mix(in_oklch,var(--brand)_55%,var(--border))] aria-pressed:bg-[var(--card)] aria-pressed:font-medium aria-pressed:text-[var(--onboarding-ink)]"
        aria-pressed={value === ''}
        onClick={() => onChange('')}
      >
        <span>全部</span>
          <small className="text-[10px] tabular-nums text-[var(--onboarding-subtle)]">{templates.length}</small>
      </button>
      {categories.map((category) => (
        <button
          key={category}
          type="button"
          className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--onboarding-line)] bg-[color-mix(in_oklch,var(--onboarding-panel)_74%,transparent)] px-[9px] text-sm text-[var(--onboarding-subtle)] hover:border-[color-mix(in_oklch,var(--brand)_55%,var(--border))] hover:bg-[var(--card)] hover:text-[var(--onboarding-ink)] aria-pressed:border-[color-mix(in_oklch,var(--brand)_55%,var(--border))] aria-pressed:bg-[var(--card)] aria-pressed:font-medium aria-pressed:text-[var(--onboarding-ink)]"
          aria-pressed={value === category}
          onClick={() => onChange(category)}
        >
          <span>{category}</span>
          <small className="text-[10px] tabular-nums text-[var(--onboarding-subtle)]">{counts.get(category)}</small>
        </button>
      ))}
    </div>
  );
}
