'use client';

import { useRef, useState } from 'react';
import { Ellipsis, Search, Code } from 'lucide-react';
import { LinkSimpleIcon, CopyIcon, PushPinIcon, PushPinSlashIcon, FileMdIcon, FileDocIcon, ClockIcon, TrashIcon } from '@phosphor-icons/react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../../components/ui/dropdown-menu';
import type { MemoItem } from '../../../lib/store';
import { SidebarToggleIcon } from '../../../components/icons/sidebar-toggle-icon';

interface DocumentTitlebarMacProps {
  currentMemo: MemoItem | null;
  isSidebarHidden: boolean;
  isSrcView: boolean;
  onToggleSidebar: () => void;
  onToggleSrcView: () => void;
  onCopyLink: () => void;
  onCopyFullText: () => void;
  onTogglePin: () => void;
  onExportMarkdown: () => void;
  onExportWord: () => void;
  onRequestDeleteMemo: () => void;
}

export function DocumentTitlebarMac({
  currentMemo,
  isSidebarHidden,
  isSrcView,
  onToggleSidebar,
  onToggleSrcView,
  onCopyLink,
  onCopyFullText,
  onTogglePin,
  onExportMarkdown,
  onExportWord,
  onRequestDeleteMemo,
}: DocumentTitlebarMacProps) {
  const [isSearchActive, setIsSearchActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSearchClick = () => {
    setIsSearchActive(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const handleSearchBlur = () => {
    setIsSearchActive(false);
  };

  const isPinned = !!currentMemo?.favorited;

  return (
    <div data-tauri-drag-region className="h-12 shrink-0 pl-[90px] pr-0 z-[50] flex items-center bg-gradient-to-b from-white/100 to-transparent ">
      {isSidebarHidden && (
        <button
          onClick={onToggleSidebar}
          className="w-8 h-8 flex items-center justify-center text-[#4D4F5B] hover:bg-black/5 rounded-xl transition-colors"
        >
          <SidebarToggleIcon className="w-5 h-5" variant="collapsed" />
        </button>
      )}
      <div className="flex-1" />
      <div className="ml-auto flex items-center gap-3 pr-2">
        {isSearchActive ? (
          <input
            ref={searchInputRef}
            type="text"
            onBlur={handleSearchBlur}
            placeholder="搜索..."
            className="w-48 h-8 px-3 text-sm border border-black/5 rounded-xl outline-none bg-white border border-black/5 focus:border-[#4D4F5B] transition-all"
          />
        ) : (
          <button
            onClick={handleSearchClick}
            className="w-8 h-8 flex items-center justify-center text-[#4D4F5B] hover:bg-black/5 rounded-xl transition-colors bg-white border border-black/5 "
          >
            <Search className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={onToggleSrcView}
          className={`w-8 h-8 flex items-center justify-center rounded-xl transition-colors bg-white border border-black/5 ${isSrcView ? 'text-[#5262DC]' : 'text-[#4D4F5B]'} hover:bg-black/5`}
        >
          <Code className="w-4 h-4" />
        </button>
        {currentMemo && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-8 h-8 flex items-center justify-center text-[#4D4F5B] hover:bg-black/5 rounded-xl transition-colors bg-white border border-black/5 ">
                <Ellipsis className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[200px] px-1 py-1.5 space-y-1">
              <DropdownMenuItem
                onClick={onCopyLink}
                className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
              >
                <LinkSimpleIcon className="w-4 h-4 mr-2" /> 复制链接
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onCopyFullText}
                className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
              >
                <CopyIcon className="w-4 h-4 mr-2" /> 复制全文
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onTogglePin}
                className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
              >
                {isPinned ? (
                  <><PushPinSlashIcon className="w-4 h-4 mr-2" /> 取消置顶</>
                ) : (
                  <><PushPinIcon className="w-4 h-4 mr-2" /> 置顶</>
                )}
              </DropdownMenuItem>
              <div className="h-px bg-black/10 mx-1" />
              <DropdownMenuItem
                onClick={onExportMarkdown}
                className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
              >
                <FileMdIcon className="w-4 h-4 mr-2" /> 导出为 Markdown
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onExportWord}
                className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
              >
                <FileDocIcon className="w-4 h-4 mr-2" /> 导出为 Word
              </DropdownMenuItem>
              <div className="h-px bg-black/10 mx-1" />
              <DropdownMenuItem className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]">
                <ClockIcon className="w-4 h-4 mr-2" /> 历史版本
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onRequestDeleteMemo}
                className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)] text-red-500"
              >
                <TrashIcon className="w-4 h-4 mr-2" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
