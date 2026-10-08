import { NotebookIcon } from '@features/memo/components/notebook-icon';

const TEMPLATE_ICONS: Record<string, string> = {
  book: 'notebook_2_fill',
  briefcase: 'briefcase_2_fill',
  chart: 'chart_bar_fill',
  code: 'terminal_box_fill',
  graduation: 'mortarboard_fill',
  'pen-line': 'mark_pen_fill',
  presentation: 'projector_fill',
  radio: 'wechat_fill',
};

export function NotebookTemplateIcon({ icon }: { icon: string }) {
  return (
    <span aria-hidden="true">
      <NotebookIcon
        icon={TEMPLATE_ICONS[icon] ?? 'notebook_2_fill'}
        className="h-6 w-6 !text-[var(--brand)]"
        imageClassName="h-full w-full"
        disableTitle
      />
    </span>
  );
}

export function NotebookTemplateCover({
  template,
}: {
  template: { id: string; icon: string; coverUrl?: string };
}) {
  const coverUrl = template.coverUrl;

  if (!coverUrl) {
    return (
      <span className="inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-[color-mix(in_oklch,var(--brand)_10%,transparent)] text-[var(--brand)]">
        <NotebookTemplateIcon icon={template.icon} />
      </span>
    );
  }

  return (
    <span className="block aspect-video w-full overflow-hidden rounded-lg bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]">
      <img className="block h-full w-full object-cover" src={coverUrl} alt="" width={512} height={288} loading="lazy" decoding="async" />
    </span>
  );
}
