import { ContentIcon } from '@features/content/public/content-api';
import { EditableCollectionName, type CollectionNameEditControls } from './editable-collection-name';

type CollectionTitleKind = 'table' | 'work_documents';

/**
 * 集合名称的小标题（tab 条左侧）：`[图标] 名字`。
 *
 * 名字的编辑交互不在本组件里 ── `EditableCollectionName` 是唯一实现
 * （大标题头 `CollectionNameHeader` 用的是同一个）。这里只管图标与排布。
 */
export function CollectionTitle({
  kind,
  title,
  inputLabel,
  renameLabel,
  renameHint,
  edit,
}: {
  kind: CollectionTitleKind;
  title: string;
  inputLabel: string;
  renameLabel: string;
  renameHint: string;
  edit: CollectionNameEditControls;
}) {
  const content = kind === 'table' ? { kind: 'multidimensional-table' as const } : { kind: 'work-documents' as const };

  return <div className="multidimensional-table__view-title flex min-w-0 max-w-[40%] shrink-0 -translate-x-[2px] items-center gap-1.5" title={title}>
    <ContentIcon content={content} className="h-5 w-5 shrink-0" />
    <EditableCollectionName
      title={title}
      size="tab"
      inputLabel={inputLabel}
      renameLabel={renameLabel}
      renameHint={renameHint}
      edit={edit}
    />
  </div>;
}
