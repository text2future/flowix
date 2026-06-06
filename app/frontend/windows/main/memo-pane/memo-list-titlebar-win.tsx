'use client';

import { SlidersHorizontal } from 'lucide-react';
import { SidebarToggleIcon } from '../../../components/icons/sidebar-toggle-icon';
import productLogo from '../../../assets/product-logo.svg';

interface MemoListTitlebarWinProps {
  onCollapseSidebar: () => void;
  onOpenPreferences: () => void;
}

export function MemoListTitlebarWin({
  onCollapseSidebar,
  onOpenPreferences,
}: MemoListTitlebarWinProps) {
  return (
    <div
      data-tauri-drag-region
      className="h-9 px-2 shrink-0 flex items-center justify-between gap-1"
    >
      {/* Product brand — anchors the top-left of the left sidebar. The
          drag-region attribute on the parent still makes the surrounding
          empty space draggable, but the inner elements are non-draggable
          by default since we don't pass data-tauri-drag-region to them. */}
      <span
        className="flex items-center gap-1.5 pl-1 select-none pointer-events-none"
        aria-label="Flowix Memo"
      >
        <img src={productLogo} alt="" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 rounded" />
        <span className="leading-none translate-y-[1px] text-[14px] font-semibold tracking-tight bg-gradient-to-r from-[#5262DC] via-[#6F5BD8] to-[#8A6DDC] bg-clip-text text-transparent">
          Flowix Memo
        </span>
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={onCollapseSidebar}
          className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-400 transition-colors"
        >
          <SidebarToggleIcon className="w-4 h-4" />
        </button>
        <button
          onClick={onOpenPreferences}
          className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-400 transition-colors"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
