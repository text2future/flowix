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
