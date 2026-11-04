import type { Editor, JSONContent, Range } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { DEFAULT_APP_LANGUAGE, type AppLanguage, type I18nKey } from '@/lib/i18n/locales';
import { translate } from '@/lib/i18n/provider';
import type { TableColumnRole, TableRowRole, TableStyleId } from './table-presentation';

export const TABLE_TEMPLATE_OPTIONS = [
  { styleId: 'default', labelKey: 'editor.table.styleDefault', keywords: ['table', 'biaoge', 'grid', '表格'] },
  { styleId: 'business-blue', labelKey: 'editor.table.styleBusinessBlue', keywords: ['table', 'biaoge', 'business', 'blue', '商务蓝', '表格'] },
  { styleId: 'striped', labelKey: 'editor.table.styleStriped', keywords: ['table', 'biaoge', 'striped', 'zebra', '灰白', '条纹', '表格'] },
  { styleId: 'comparison', labelKey: 'editor.table.styleComparison', keywords: ['table', 'biaoge', 'comparison', 'compare', '对比', '表格'] },
  { styleId: 'financial-brief', labelKey: 'editor.table.styleFinancialBrief', keywords: ['table', 'biaoge', 'financial brief', 'finance', '财务', '财报', '简报', '表格'] },
  { styleId: 'hk-financial', labelKey: 'editor.table.styleHkFinancial', keywords: ['table', 'biaoge', 'financial', 'hong kong', 'caibao', '港股', '财报', '表格'] },
  { styleId: 'three-line', labelKey: 'editor.table.styleThreeLine', keywords: ['table', 'biaoge', 'three-line', 'academic', 'sanxian', '三线表', '科研', '表格'] },
  { styleId: 'grouped', labelKey: 'editor.table.styleGrouped', keywords: ['table', 'biaoge', 'grouped', 'research', '分组', '横线', '科研', '表格'] },
  { styleId: 'minimal', labelKey: 'editor.table.styleMinimal', keywords: ['table', 'biaoge', 'minimal', 'research', '极简', '细线', '科研', '表格'] },
  { styleId: 'literature', labelKey: 'editor.table.styleLiterature', keywords: ['table', 'biaoge', 'literature', 'compact', '文献', '紧凑', '科研', '表格'] },
] as const satisfies ReadonlyArray<{ styleId: TableStyleId; labelKey: I18nKey; keywords: readonly string[] }>;

export function createTableTemplate(styleId: TableStyleId, language: AppLanguage = DEFAULT_APP_LANGUAGE): JSONContent {
  const t = (key: I18nKey) => translate(language, key);
  let rows: string[][];
  let columns: TableColumnRole[];
  let roles: TableRowRole[] = [];

  if (styleId === 'hk-financial') {
    rows = [
      [t('editor.table.template.item'), t('editor.table.columnNote'), t('editor.table.template.currentPeriod'), t('editor.table.template.priorPeriod')],
      ...([
        'editor.table.template.revenue', 'editor.table.template.cost', 'editor.table.template.grossProfit',
        'editor.table.template.profitBeforeTax', 'editor.table.template.tax', 'editor.table.template.profitForYear',
      ] as const).map(key => [t(key), '', '', '']),
    ];
    columns = ['label', 'note', 'amount', 'amount'];
    roles = ['body', 'body', 'body', 'subtotal', 'subtotal', 'body', 'total'];
  } else if (styleId === 'three-line') {
    rows = [
      [t('editor.table.template.metric'), t('editor.table.template.groupA'), t('editor.table.template.groupB'), t('editor.table.template.pValue')],
      ['', '', '', ''], ['', '', '', ''], ['', '', '', ''],
    ];
    columns = ['label', 'amount', 'amount', 'amount'];
  } else if (['business-blue', 'striped', 'comparison', 'financial-brief'].includes(styleId)) {
    rows = [
      [t('editor.table.template.operatingMetric'), t('editor.table.template.priorPeriod'), t('editor.table.template.currentPeriod'), t('editor.table.template.yearOverYear')],
      ...([
        'editor.table.template.coreRevenue', 'editor.table.template.newBusinessRevenue', 'editor.table.template.totalRevenue',
        'editor.table.template.operatingCost', 'editor.table.template.operatingExpenses', 'editor.table.template.operatingProfit',
      ] as const).map(key => [t(key), '', '', '']),
    ];
    columns = ['label', 'amount', 'amount', 'amount'];
    roles = ['body', 'body', 'body', 'subtotal', 'body', 'body', 'total'];
  } else if (styleId === 'minimal' || styleId === 'literature' || styleId === 'grouped') {
    rows = [[t('editor.table.template.study'), t('editor.table.template.designSample'), t('editor.table.template.mainFindings'), t('editor.table.template.limitations')]];
    columns = ['label', 'default', 'default', 'default'];
    if (styleId === 'grouped') {
      roles = ['body'];
      for (const key of ['editor.table.template.randomizedTrials', 'editor.table.template.observationalStudies', 'editor.table.template.evidenceSynthesis'] as const) {
        rows.push([t(key)], ['', '', '', ''], ['', '', '', '']);
        roles.push('group', 'body', 'body');
      }
    } else {
      rows.push(['', '', '', ''], ['', '', '', ''], ['', '', '', '']);
    }
  } else {
    rows = Array.from({ length: 3 }, () => ['', '', '']);
    columns = ['default', 'default', 'default'];
  }

  return {
    type: 'table', attrs: { styleId },
    content: rows.map((row, rowIndex) => ({
      type: 'tableRow', attrs: { role: roles[rowIndex] ?? 'body' },
      content: row.map((text, columnIndex) => ({
        type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
        attrs: {
          columnRole: columns[columnIndex],
          ...(roles[rowIndex] === 'group' ? { colspan: columns.length } : {}),
        },
        content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }],
      })),
    })),
  };
}

export function insertTableTemplate(
  editor: Editor,
  styleId: TableStyleId,
  { language = DEFAULT_APP_LANGUAGE, replaceRange }: { language?: AppLanguage; replaceRange?: Range } = {},
): boolean {
  if (editor.isDestroyed || !editor.isEditable || !editor.schema.nodes.table || editor.isActive('table')) return false;
  return editor.chain().focus().command(({ tr, dispatch }) => {
    if (replaceRange && (replaceRange.from < 0 || replaceRange.to < replaceRange.from || replaceRange.to > tr.doc.content.size)) return false;
    if (dispatch) {
      const table = editor.schema.nodeFromJSON(createTableTemplate(styleId, language));
      const offset = (replaceRange?.from ?? tr.selection.from) + 1;
      if (replaceRange) tr.replaceWith(replaceRange.from, replaceRange.to, table);
      else tr.replaceSelectionWith(table);
      tr.setSelection(TextSelection.near(tr.doc.resolve(offset)));
      // Start in the first blank cell, preserving the template's header labels.
      const { $from } = tr.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name !== 'table') continue;
        let blankPosition: number | undefined;
        table.descendants((node, position) => {
          if (blankPosition === undefined && node.isTextblock && node.content.size === 0) blankPosition = position + 1;
        });
        if (blankPosition !== undefined) {
          tr.setSelection(TextSelection.create(tr.doc, $from.start(depth) + blankPosition));
        }
        break;
      }
      tr.scrollIntoView();
    }
    return true;
  }).run();
}
