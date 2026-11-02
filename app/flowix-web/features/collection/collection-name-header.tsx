'use client';

/**
 * 集合名称标题头 ── `名称`（+ 副标题），**直接打开的集合**使用（点文件夹或直接打开集合文件）。
 *
 * 一个集合只有一个名字，名字从路径派生（见 `collectionHeaderTitle`）：
 *   - `.index.yaml` 没有集合文件名，**文件夹即集合名称**；
 *   - 其它集合文件用文件名（去掉 `.table/.lib/.workdocs.yaml` 后缀），走集合图标。
 *
 * 标题本身可编辑：双击改名（改文件夹名 / 改集合文件名），交互与 tab 条左侧的小标题
 * 同一套实现（见 `EditableCollectionName`），包括 hover 底色、圆角、双击聚焦、
 * Enter/失焦保存、Esc 退出。
 *
 * 图标（`CollectionHeaderIcon`）默认随头图走：头图可见时由外壳把图标叠在头图
 * 下半部展示，头图隐藏时回退为标题行内的方块图标（`showIcon` 控制）。
 *
 * 副标题（`subtitle`）：标题下方的一行输入框，内容落集合属性 `subtitle`（Text）；
 * 平时单行，内容超宽自动换行并随之增高（`field-sizing:content`），Enter 提交。
 * 集合缺失或不可编辑时只读不可写。
 *
 * 嵌入场景（编辑器引用节点、表格自身 nav）不用这个标题头：那里名字由表格 nav 的
 * 小标题渲染。两处共用 `useCollectionTitleVisibility()` 这条偏好，
 * 「···」→「显示标题」对两者行为一致。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CollectionIcon, type CollectionDefaultIcon } from './collection-icon';
import { cn } from '@/lib/utils';
import { collectionDisplayName } from './model';
import { EditableCollectionName, type CollectionNameEditControls } from './editable-collection-name';

export interface CollectionHeaderTitle {
  name: string;
  kind: 'folder' | 'file';
}

/** 从集合文件路径派生标题头的名称与路径类别。 */
export function collectionHeaderTitle(filePath: string): CollectionHeaderTitle {
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() ?? '';
  // `.index.yaml` 本身不是名字：集合名就是它所在的文件夹（v3 hybrid 与文件夹集合一致）。
  if (/^\.index\.ya?ml$/i.test(fileName)) return { name: collectionDisplayName(filePath, 'folder'), kind: 'folder' };
  return { name: collectionDisplayName(filePath, 'standalone'), kind: 'file' };
}

/** Persisted user icons take precedence over the first view's default icon. */
export function CollectionHeaderIcon({ defaultIcon, iconSrc }: {
  defaultIcon?: CollectionDefaultIcon; iconSrc?: string;
}) {
  return <CollectionIcon defaultIcon={defaultIcon} iconSrc={iconSrc}
    className={iconSrc ? 'h-6 w-6 object-contain' : 'h-[18px] w-[18px]'} />;
}

/**
 * 行内图标的底色色相：头图隐藏回退到标题行内时，由外壳按标题派生后传入
 * （与头图占位同一套规则，实现留在 features/surface/collection-banner-tint.ts）。
 * features 之间只传数字不共享实现，避免 collection 反向依赖 surface；
 * 不传则回落固定的 muted 底色。
 */
export type CollectionIconHue = number;

/** 副标题的读值与写入口都由外壳提供（值存集合属性 `subtitle`）。 */
export interface CollectionHeaderSubtitle {
  value: string;
  /** 集合可编辑且已存在时才可写。 */
  editable: boolean;
  inputLabel: string;
  placeholder: string;
  onSave: (value: string) => void;
}

/** 集合名称标题头：可编辑名称（+ 可选行内图标）+ 可选副标题。 */
export function CollectionNameHeader({ name, edit, inputLabel, renameLabel, renameHint, showIcon = true, iconHue, subtitle, iconSrc, iconSlot, defaultIcon }: CollectionHeaderTitle & {
  edit: CollectionNameEditControls;
  inputLabel: string;
  renameLabel: string;
  renameHint: string;
  /** 头图可见时外壳把图标叠到头图上，这里传 false 隐藏行内图标。 */
  showIcon?: boolean;
  /** 行内图标的底色色相（标题派生，外壳传入）；不传回落固定的 muted 底色。 */
  iconHue?: CollectionIconHue;
  /** 自定义集合图标（属性图标 URL）；指定时覆盖默认集合图标。 */
  iconSrc?: string;
  defaultIcon?: CollectionDefaultIcon;
  /** 标题行内的图标槽：外壳传可点击的图标按钮（隐藏头图时也能 picker 换图标）；
   * 不传则回落静态方块图标（缺集合 / 只读场景）。 */
  iconSlot?: ReactNode;
  subtitle?: CollectionHeaderSubtitle;
}) {
  return <div className="flex shrink-0 flex-col gap-0.5 px-4 pb-2 pt-4">
    <div className="flex items-center gap-3">
      {showIcon ? (
        iconSlot ?? (
          <span
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--muted-foreground)]',
              iconHue === undefined ? 'bg-[var(--muted)]' : 'collection-header-icon-tint',
            )}
          >
            <CollectionHeaderIcon defaultIcon={defaultIcon} iconSrc={iconSrc} />
          </span>
        )
      ) : null}
      <h2 className="-ml-2 flex min-w-0 flex-1 items-center">
        <EditableCollectionName
          title={name}
          size="header"
          inputLabel={inputLabel}
          renameLabel={renameLabel}
          renameHint={renameHint}
          edit={edit}
        />
      </h2>
    </div>
    {subtitle ? <CollectionSubtitleInput subtitle={subtitle} /> : null}
  </div>;
}

/**
 * 副标题输入框：平时单行，`field-sizing:content` 让框随内容自适应；
 * 内容超宽自动换行、框随之增高。文字用前景色展示（placeholder 才是弱化色）。
 * Enter 提交（不换行）；点击输入框以外的任何地方都退出编辑并提交。
 */
function CollectionSubtitleInput({ subtitle }: { subtitle: CollectionHeaderSubtitle }) {
  const [draft, setDraft] = useState(subtitle.value);
  /** 是否处于编辑中（聚焦）。 */
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 本次编辑已提交过的值：外点兜底与失焦会连着触发两次 commit，这里同步去重。 */
  const committedRef = useRef(subtitle.value);
  // 外部值变化（落盘回读 / 其它入口写入）时同步本地草稿与已提交值。
  useEffect(() => {
    setDraft(subtitle.value);
    committedRef.current = subtitle.value;
  }, [subtitle.value]);

  const commit = useCallback(() => {
    const next = draft.replace(/\s+$/g, '');
    // 幂等：值没变，或这次编辑已经提交过（第 2 次 commit 与第 1 次并发，
    // 会让两个请求带同一 expectedRevision 落盘，后到的必然 revision 冲突）。
    if (next === subtitle.value || next === committedRef.current) return;
    committedRef.current = next;
    subtitle.onSave(next);
  }, [draft, subtitle]);

  /**
   * 点击输入框以外的任何地方都退出编辑：blur 的默认行为可能被滚动 / 拖拽层
   * 的 preventDefault 吞掉，这里在 document 捕获阶段兜底提交并失焦。
   */
  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = inputRef.current;
      if (!node || (event.target instanceof Node && node.contains(event.target))) return;
      commit();
      node.blur();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [commit, editing]);

  return <textarea
    ref={inputRef}
    rows={1}
    value={draft}
    placeholder={subtitle.placeholder}
    aria-label={subtitle.inputLabel}
    disabled={!subtitle.editable}
    onChange={(event) => setDraft(event.currentTarget.value)}
    onFocus={() => setEditing(true)}
    onKeyDown={(event) => {
      if (event.key === 'Enter') {
        // 单行语义：Enter 是提交而不是换行。
        event.preventDefault();
        event.currentTarget.blur();
      }
    }}
    onBlur={() => { commit(); setEditing(false); }}
    className={cn(
      'w-full resize-none overflow-hidden rounded-lg border-0 bg-transparent px-2 py-1 text-sm leading-relaxed -ml-2',
      'text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]/70',
      'max-h-32 [field-sizing:content]',
      // 显式透明，避免 Windows WebView2 使用 textarea 原生底色；hover / 聚焦也不铺底色。
      !subtitle.editable && 'cursor-default opacity-80',
    )}
  />;
}
