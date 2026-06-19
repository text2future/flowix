'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';
import { X, ArrowUp, ArrowDown, ChevronRight, ChevronDown, Replace, ReplaceAll } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Tooltip } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utils';

interface SearchReplacePanelProps {
  editor: Editor | null;
  visible: boolean;
  onClose: () => void;
}

export function SearchReplacePanel({ editor, visible, onClose }: SearchReplacePanelProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [replaceTerm, setReplaceTerm] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showReplace, setShowReplace] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editor) return;
    const storage = editor.storage.searchAndReplace as any;
    setSearchTerm(storage.searchTerm || '');
    setReplaceTerm(storage.replaceTerm || '');
    setMatchCount(storage.results?.length || 0);
    setCurrentIndex(storage.resultIndex || 0);
  }, [editor, visible]);

  useEffect(() => {
    if (visible && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [visible]);

  useEffect(() => {
    if (!editor) return;

    const updateFromStorage = () => {
      const storage = editor.storage.searchAndReplace as any;
      setMatchCount(storage.results?.length || 0);
      setCurrentIndex(storage.resultIndex || 0);
    };

    editor.on('transaction', updateFromStorage);
    return () => {
      editor.off('transaction', updateFromStorage);
    };
  }, [editor]);

  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      (editor?.commands as any).setSearchTerm(value);
    }, 150);
  };

  const handleReplaceChange = (value: string) => {
    setReplaceTerm(value);
    (editor?.commands as any).setReplaceTerm(value);
  };

  const handlePrev = () => {
    (editor?.commands as any).previousSearchResult();
  };

  const handleNext = () => {
    (editor?.commands as any).nextSearchResult();
  };

  const handleReplace = () => {
    (editor?.commands as any).replace();
  };

  const handleReplaceAll = () => {
    (editor?.commands as any).replaceAll();
  };

  const handleClose = () => {
    (editor?.commands as any).closeSearch();
    onClose();
  };

  // Auto-scroll current match into view
  useEffect(() => {
    if (!editor || !visible) return;

    const scrollToCurrentMatch = () => {
      requestAnimationFrame(() => {
        const currentEl = editor.view?.dom.querySelector('.search-result-current');
        if (currentEl) {
          currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    };

    editor.on('transaction', scrollToCurrentMatch);
    return () => {
      editor.off('transaction', scrollToCurrentMatch);
    };
  }, [editor, visible]);

  // 点外面 (编辑器正文 / 其它区域) 关闭面板 — 仅在 visible=true 时挂监听, 关闭后立即卸载,
  // 避免对编辑器内正常点击造成干扰。
  // 用 mousedown 而非 click: mousedown 在 focus/blur 之前触发, 行为更可预测。
  useEffect(() => {
    if (!visible) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && panelRef.current && !panelRef.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <div ref={panelRef} className="absolute top-0 left-1/2 -translate-x-1/2 z-[200] bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-lg p-2 flex flex-col gap-1.5 min-w-[320px] max-w-[480px] animate-in slide-in-from-top-2 fade-in duration-200">
      {/* Search row */}
      <div className="flex items-center gap-1.5">
        <Tooltip content="切换替换">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setShowReplace(!showReplace)}
          >
            {showReplace ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </Button>
        </Tooltip>

        <div className="relative flex-1">
          <Input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="搜索..."
            className="pr-9 h-8 text-sm"
          />
          {matchCount > 0 && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
              {currentIndex + 1}/{matchCount}
            </span>
          )}
        </div>

        <Tooltip content="上一处">
          <Button variant="ghost" size="icon-xs" onClick={handlePrev} disabled={matchCount === 0}>
            <ArrowUp className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="下一处">
          <Button variant="ghost" size="icon-xs" onClick={handleNext} disabled={matchCount === 0}>
            <ArrowDown className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="关闭">
          <Button variant="ghost" size="icon-xs" onClick={handleClose} className="hover:bg-transparent dark:hover:bg-transparent hover:text-destructive">
            <X className="size-3.5" />
          </Button>
        </Tooltip>
      </div>

      {/* Replace row */}
      <div className={cn("flex items-center gap-1.5", !showReplace && "hidden")}>
        <div className="w-6" />
        <div className="relative flex-1">
          <Input
            ref={replaceInputRef}
            value={replaceTerm}
            onChange={(e) => handleReplaceChange(e.target.value)}
            placeholder="替换为..."
            className="h-8 text-sm pr-9"
          />
        </div>
        <Tooltip content="替换">
          <Button variant="ghost" size="icon-xs" onClick={handleReplace} disabled={matchCount === 0} className="hover:bg-[color-mix(in_oklch,var(--primary)_10%,transparent)] hover:text-[var(--primary)]">
            <Replace className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="全部替换">
          <Button variant="ghost" size="icon-xs" onClick={handleReplaceAll} disabled={matchCount === 0} className="hover:bg-[color-mix(in_oklch,var(--success)_10%,transparent)] hover:text-[var(--success)]">
            <ReplaceAll className="size-3.5" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}