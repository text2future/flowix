'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { ChatCircleTextIcon, TrashIcon } from '@phosphor-icons/react';
import { ChevronDown } from 'lucide-react';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { toast } from '../../../lib/toast';
import { useChatStore } from '../../../lib/store/chat-store';
import { cn } from '../../../lib/utils';
import type { ThreadListItem } from '../../../types';
import { getAgentRole } from '../../../lib/agent-roles';

interface ChatHistoryProps {
	onSelectThread?: (threadId: string) => void;
}

function ThreadRow({
	item,
	onSelect,
	onDelete,
}: {
	item: ThreadListItem;
	onSelect: (tid: string) => void;
	onDelete?: (e: MouseEvent, tid: string) => void;
}) {
	const isRunning = useChatStore(
		(s) => s.threadStates[item.threadId]?.isLoading ?? false
	);

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => onSelect(item.threadId)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onSelect(item.threadId);
				}
			}}
			className={cn(
				'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5',
				'outline-none transition-colors hover:bg-[var(--muted)] focus:bg-[var(--muted)]'
			)}
		>
			<ChatCircleTextIcon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
			<span className="min-w-0 flex-1 truncate text-left text-sm text-[var(--agent-foreground)]">
				{item.title || '未命名'}
			</span>
			{isRunning && (
				<span
					aria-label="后台运行中"
					title="后台运行中"
					className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500"
				/>
			)}
			<span className="shrink-0 text-xs text-[var(--muted-foreground)] group-hover:hidden">
				{formatRelativeTime(item.updatedAt || item.createdAt)}
			</span>
			{onDelete && (
				<button
					type="button"
					onClick={(e) => onDelete(e, item.threadId)}
					onMouseDown={(e) => e.stopPropagation()}
					aria-label="删除对话"
					className={cn(
						'h-4 shrink-0 hidden items-center justify-center rounded px-1',
						'text-[var(--muted-foreground)] transition-colors cursor-pointer',
						'hover:bg-[var(--accent)] hover:text-red-500 group-hover:inline-flex'
					)}
				>
					<TrashIcon className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}

export function ChatHistory({ onSelectThread }: ChatHistoryProps) {
	const [open, setOpen] = useState(false);

	const activeRoleKey = useChatStore((state) => state.activeAgentRoleKey);
	const activeRole = getAgentRole(activeRoleKey);
	const threadList = useChatStore((state) =>
		getAgentRole(state.activeAgentRoleKey).runtime === 'codex' ? state.codexThreadList : state.threadList
	);
	const currentThreadTitle = useChatStore((state) =>
		getAgentRole(state.activeAgentRoleKey).runtime === 'codex'
			? state.currentCodexThreadTitle
			: state.currentThreadTitle
	);
	const loadThreadList = useChatStore((state) => state.loadThreadList);
	const loadCodexThreadList = useChatStore((state) => state.loadCodexThreadList);
	const deleteThread = useChatStore((state) => state.deleteThread);

	useEffect(() => {
		if (!open) return;
		if (activeRole.runtime === 'codex') {
			loadCodexThreadList();
		} else {
			loadThreadList();
		}
	}, [activeRole.runtime, loadCodexThreadList, loadThreadList, open]);

	const handleSelectThread = (threadId: string) => {
		onSelectThread?.(threadId);
		setOpen(false);
	};

	const handleCreateThread = () => {
		const store = useChatStore.getState();
		if (getAgentRole(store.activeAgentRoleKey).runtime === 'codex') {
			store.createCodexThread();
		} else {
			store.createThread();
		}
		setOpen(false);
	};

	const handleDeleteThread = async (e: MouseEvent, threadId: string) => {
		e.stopPropagation();
		e.preventDefault();
		try {
			await deleteThread(threadId);
		} catch (err) {
			console.error('Failed to delete thread:', err);
			toast.error('删除失败');
		}
	};

	return (
		<div className="min-w-0 flex-1 [-webkit-app-region:no-drag]">
			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="group flex max-w-full min-w-0 cursor-pointer items-center gap-1 overflow-hidden rounded-md px-2 py-0.5 transition-colors [-webkit-app-region:no-drag]"
					>
						<span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--agent-foreground)] transition-colors duration-150 group-hover:text-[color-mix(in_oklch,var(--agent-foreground)_80%,white)]">
							{currentThreadTitle || '未命名对话'}
						</span>
						<ChevronDown
							className="h-[14px] w-[14px] shrink-0 text-[var(--muted-foreground)]"
							strokeWidth={2.5}
						/>
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-[280px] space-y-1 px-1 py-1.5">
					<DropdownMenuLabel className="px-2 pb-1 text-xs uppercase tracking-wider text-[var(--muted-foreground)]">
						{activeRole.name} 历史
					</DropdownMenuLabel>
					<div className="max-h-[300px] space-y-1 overflow-y-auto">
						{threadList.length === 0 ? (
							<div className="px-2 py-3 text-center text-sm text-[var(--muted-foreground)]">
								暂无历史对话
							</div>
						) : (
							threadList.map((item) => (
								<ThreadRow
									key={item.threadId}
									item={item}
									onSelect={handleSelectThread}
									onDelete={activeRole.runtime === 'codex' ? undefined : handleDeleteThread}
								/>
							))
						)}
					</div>
					<div className="p-0">
						<button
							type="button"
							onClick={handleCreateThread}
							className={cn(
								'flex w-full cursor-pointer items-center justify-center rounded-md px-2 py-1.5',
								'border border-[var(--border)] text-sm text-[var(--agent-foreground)]',
								'transition-colors hover:bg-[var(--muted)]'
							)}
						>
							<span>新建对话</span>
						</button>
					</div>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diffMs = Math.max(0, now - timestamp);
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
