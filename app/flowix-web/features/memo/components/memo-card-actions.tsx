'use client';

import { PushPin, TrashSimpleIcon } from "@phosphor-icons/react";
import { cn } from '@/lib/utils';
import type { MemoItem } from '@features/memo';

// Minimal contract every shadcn-style item primitive in this app satisfies:
// it accepts an onClick, a className, and renders children. Both
// `DropdownMenuItem` and `ContextMenuItem` match this, so we can render the
// same actions inside either menu without forking the JSX.
export interface MenuItemComponent {
  (props: {
    onClick?: () => void;
    className?: string;
    children: React.ReactNode;
  }): React.ReactElement | null;
}

interface MemoCardActionsProps {
  memo: MemoItem;
  onFavoriteToggle: (memo: MemoItem) => void;
  onDelete: (memo: MemoItem) => void;
  Item: MenuItemComponent;
}

const ITEM_BASE =
  "flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]";

export function MemoCardActions({
  memo,
  onFavoriteToggle,
  onDelete,
  Item,
}: MemoCardActionsProps) {
  return (
    <>
      <Item onClick={() => onFavoriteToggle(memo)} className={ITEM_BASE}>
        {memo.favorited ? (
          <>
            <PushPin weight="fill" className="w-4 h-4 mr-2" /> 取消置顶
          </>
        ) : (
          <>
            <PushPin className="w-4 h-4 mr-2" /> 置顶
          </>
        )}
      </Item>
      <Item
        onClick={() => onDelete(memo)}
        className={cn(ITEM_BASE, "hover:text-[var(--destructive)]")}
      >
        <TrashSimpleIcon className="w-4 h-4 mr-2" /> 删除
      </Item>
    </>
  );
}
