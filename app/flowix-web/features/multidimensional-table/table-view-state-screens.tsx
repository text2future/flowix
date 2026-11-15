import { Table2 } from 'lucide-react';

import { Button } from '@shared/ui/button';
import type { I18nKey } from '@/lib/i18n';

/**
 * 表格集合读不出来时的整屏错误态。它有两种宿主：编辑器里内嵌的引用节点（可移除引用）
 * 与独立打开的表格文档（可删除文件），差异只在按钮行，所以用一个组件加两个开关表达。
 */
export function TableLoadErrorScreen({
  embeddedInEditor,
  loadError,
  editable,
  placement,
  t,
  onReload,
  onRemoveReference,
  onDeleteFile,
}: {
  embeddedInEditor: boolean;
  loadError: string;
  editable: boolean;
  placement: string | undefined;
  t: (key: I18nKey) => string;
  onReload: () => void;
  onRemoveReference?: () => void;
  onDeleteFile: () => void;
}) {
  return <div className={`flex h-full min-h-0 flex-col items-center justify-center gap-3 p-8 text-center ${embeddedInEditor ? 'rounded-lg border border-[var(--border)] bg-[var(--editor-block-bg)]' : ''}`}>
    <Table2 className="h-8 w-8 text-[var(--muted-foreground)] opacity-70" aria-hidden="true" />
    <div className="text-sm">无法显示多维表格</div>
    {loadError !== '不支持的多维表格文件格式' && <div className="max-w-lg text-xs text-[var(--muted-foreground)]">{t('errors.friendly.tableLoad')}</div>}
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={onReload}>重新加载</Button>
      {embeddedInEditor
        ? onRemoveReference && <Button type="button" variant="outline" size="sm" className="rounded-lg" disabled={!editable} onClick={onRemoveReference}>移除</Button>
        : placement !== 'folder' && <Button type="button" variant="outline" size="sm" className="rounded-lg text-[var(--destructive)]" disabled={!editable} onClick={onDeleteFile}>删除多维表格</Button>}
    </div>
  </div>;
}

/** 引用节点保存的 table.id 与当前路径解析出的集合身份不一致：只能由用户重新选表。 */
export function TableIdentityMismatchScreen() {
  return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
    <Table2 className="h-7 w-7 text-[var(--muted-foreground)]" aria-hidden="true" />
    <div className="text-sm font-medium">引用的表格身份已变化</div>
    <div className="max-w-lg text-xs text-[var(--muted-foreground)]">当前路径对应的多维表格与引用节点保存的 table.id 不一致，请重新选择表格。</div>
  </div>;
}
