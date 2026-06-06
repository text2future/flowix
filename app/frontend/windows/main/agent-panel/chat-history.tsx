'use client';

import { useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { ChatCircleTextIcon } from '@phosphor-icons/react';
import { cn } from '../../../lib/utils';
import { useChatStore } from '../../../lib/store/chat-store';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';

interface ChatHistoryProps {
	onSelectThread?: (threadId: string) => void;
}

export function ChatHistory({ onSelectThread }: ChatHistoryProps) {
	const [open, setOpen] = useState(false);

	const threadList = useChatStore((state) => state.threadList);
	const currentThreadTitle = useChatStore((state) => state.currentThreadTitle);
	const loadThreadList = useChatStore((state) => state.loadThreadList);

	useEffect(() => {
		if (open) {
			loadThreadList();
		}
	}, [open, loadThreadList]);

	const handleSelectThread = (threadId: string) => {
		onSelectThread?.(threadId);
		setOpen(false);
	};

	const handleCreateThread = () => {
		const store = useChatStore.getState();
		store.createThread();
		setOpen(false);
	};

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className={cn(
						'flex items-center gap-1 px-1 rounded-md cursor-pointer active:scale-95 transition-all'
					)}
				>
					<span className="text-sm text-[var(--foreground)] truncate font-medium min-w-0">
						{currentThreadTitle || 'Untitled Chat'}
					</span>
					<ChevronDown className="w-4 h-4 text-[var(--muted-foreground)] shrink-0" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-[280px] max-h-[360px] overflow-y-auto px-1 py-1.5 space-y-1">
				<DropdownMenuLabel className="px-2">历史对话</DropdownMenuLabel>
				{threadList.length === 0 ? (
					<div className="px-2 py-1.5 text-sm text-[var(--muted-foreground)]">
						暂无历史对话
					</div>
				) : (
					threadList.map((item, index) => (
						<DropdownMenuItem
							key={item.threadId || `thread-${index}`}
							onClick={() => handleSelectThread(item.threadId)}
							className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)] gap-2"
						>
							<ChatCircleTextIcon className="w-4 h-4 shrink-0 text-[var(--muted-foreground)]" />
							<span className="flex-1 min-w-0 truncate text-left text-sm text-[var(--foreground)]">
								{item.title || 'Untitled'}
							</span>
							<span className="text-xs text-[var(--muted-foreground)] shrink-0">
								{formatRelativeTime(item.createdAt)}
							</span>
						</DropdownMenuItem>
					))
				)}
				<DropdownMenuItem
					onClick={handleCreateThread}
					className="flex items-center justify-center cursor-pointer rounded-md border border-[var(--border)] w-full hover:bg-[var(--muted)]"
				>
					<span>新建对话</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diffMs = now - timestamp;
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHour = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHour / 24);

	if (diffSec < 60) return '刚刚';
	if (diffMin < 60) return `${diffMin}分钟前`;
	if (diffHour < 24) return `${diffHour}小时前`;
	if (diffDay < 7) return `${diffDay}天前`;
	return new Date(timestamp).toLocaleDateString('zh-CN');
}
