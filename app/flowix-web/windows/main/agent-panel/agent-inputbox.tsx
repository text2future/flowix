import { displayTitleFromFilename } from "../../../lib/utils";
import React, { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Check, Cpu, FileText, Hash, Plus, Shield, X } from "lucide-react";
import { PaperPlaneRight, Stop } from "@phosphor-icons/react";
import { AITextarea } from "../../../components/ui/aitextarea";
import { Button } from "../../../components/ui/button";
import { Tooltip } from "../../../components/ui/tooltip";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { InputboxAdd } from "./inputbox-add";
import { CitationCard } from "./citation-card";
import { type MemoItem } from "../../../lib/store";
import { useMemoStore } from "../../../lib/store";
import { useChatStore } from "../../../lib/store/chat-store";
import { agent } from "../../../lib/tauri/client";
import type { AgentCodexModel, AgentPermissionMode } from "../../../types/agent";

interface InputboxProps {
	onSend: (content: string, options?: { includeSelectedFile?: boolean; memos?: MemoItem[] }) => void;
	isLoading?: boolean;
	onStop?: () => void;
}

interface BaseInputboxProps extends InputboxProps {
	showPermissionMode?: boolean;
	showModelMode?: boolean;
}

const MIN_HEIGHT = 44;
const MAX_HEIGHT = 180;
const MAX_MEMOS = 10;

const PERMISSION_OPTIONS: Array<{
	id: AgentPermissionMode;
	label: string;
}> = [
	{ id: "inherit", label: "默认" },
	{ id: "read-only", label: "可读" },
	{ id: "workspace-write", label: "可编辑" },
	{ id: "danger-full-access", label: "完全访问" },
];

const CODEX_MODEL_OPTIONS: Array<{
	id: AgentCodexModel;
	label: string;
}> = [
	{ id: "gpt-5.5", label: "GPT-5.5" },
	{ id: "gpt-5", label: "GPT-5" },
	{ id: "gpt-5-codex", label: "GPT-5 Codex" },
];

function PermissionModeMenu() {
	const agentPermissionMode = useChatStore((state) => state.agentPermissionMode);
	const setAgentPermissionMode = useChatStore((state) => state.setAgentPermissionMode);
	const currentPermission =
		PERMISSION_OPTIONS.find((option) => option.id === agentPermissionMode) ?? PERMISSION_OPTIONS[0];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="flex h-8 items-center gap-1 rounded-full px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
					aria-label="权限模式"
				>
					<Shield className="h-4 w-4" />
					<span className="max-w-[64px] truncate">{currentPermission.label}</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" side="top" className="w-[200px] px-1 py-1.5 space-y-1">
				<DropdownMenuLabel className="text-xs uppercase tracking-wider text-[var(--muted-foreground)] px-2 pb-1">
					权限模式
				</DropdownMenuLabel>
				{PERMISSION_OPTIONS.map((option) => (
					<DropdownMenuItem
						key={option.id}
						onClick={() => setAgentPermissionMode(option.id)}
						className="flex cursor-pointer items-center justify-between rounded-md px-2 hover:bg-[var(--muted)]"
					>
						<span>{option.label}</span>
						{option.id === agentPermissionMode && (
							<Check className="w-4 h-4 text-[var(--primary)]" />
						)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function CodexModelMenu() {
	const agentCodexModel = useChatStore((state) => state.agentCodexModel);
	const setAgentCodexModel = useChatStore((state) => state.setAgentCodexModel);
	const [defaultModel, setDefaultModel] = useState("Codex 默认");

	useEffect(() => {
		let cancelled = false;
		agent
			.getCodexDefaultModel()
			.then((model) => {
				if (!cancelled && model.trim()) {
					setDefaultModel(model.trim());
				}
			})
			.catch(() => {
				if (!cancelled) {
					setDefaultModel("Codex 默认");
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const options = useMemo(() => {
		const base = [
			{ id: "inherit", label: `默认 (${defaultModel})` },
			...CODEX_MODEL_OPTIONS,
		];
		if (
			agentCodexModel !== "inherit" &&
			!base.some((option) => option.id === agentCodexModel)
		) {
			base.push({ id: agentCodexModel, label: agentCodexModel });
		}
		return base;
	}, [agentCodexModel, defaultModel]);

	const currentModel =
		options.find((option) => option.id === agentCodexModel) ?? options[0];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="flex h-8 items-center gap-1 rounded-full px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
					aria-label="模型"
				>
					<Cpu className="h-4 w-4" />
					<span className="max-w-[88px] truncate">{currentModel.label}</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" side="top" className="w-[200px] px-1 py-1.5 space-y-1">
				<DropdownMenuLabel className="text-xs uppercase tracking-wider text-[var(--muted-foreground)] px-2 pb-1">
					模型
				</DropdownMenuLabel>
				{options.map((option) => (
					<DropdownMenuItem
						key={option.id}
						onClick={() => setAgentCodexModel(option.id)}
						className="flex cursor-pointer items-center justify-between rounded-md px-2 hover:bg-[var(--muted)]"
					>
						<span className="truncate">{option.label}</span>
						{option.id === agentCodexModel && (
							<Check className="w-4 h-4 text-[var(--primary)]" />
						)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const BaseInputbox = forwardRef<HTMLTextAreaElement, BaseInputboxProps>((props, ref) => {
	const { onSend, isLoading, onStop, showPermissionMode = false, showModelMode = false } = props;
	const [input, setInput] = useState("");
	const [selectedMemos, setSelectedMemos] = useState<MemoItem[]>([]);
	const [inputboxMemos, setInputboxMemos] = useState<MemoItem[]>([]);
	const [isComposing, setIsComposing] = useState(false);
	const internalRef = useRef<HTMLTextAreaElement>(null);
	const textareaRef = (ref as React.RefObject<HTMLTextAreaElement>) || internalRef;

	const { memos } = useMemoStore();
	const pendingPrompt = useChatStore((state) => state.pendingPrompt);
	const consumePendingPrompt = useChatStore((state) => state.consumePendingPrompt);
	const pendingCitation = useChatStore((state) => state.pendingCitation);
	const setPendingCitation = useChatStore((state) => state.setPendingCitation);

	useEffect(() => {
		if (memos && memos.length > 0) {
			setInputboxMemos(memos);
		}
	}, [memos]);

	useEffect(() => {
		if (pendingPrompt === undefined) return;
		setInput(pendingPrompt);
		consumePendingPrompt();
		requestAnimationFrame(() => {
			const textarea = textareaRef.current;
			if (!textarea) return;
			textarea.style.height = "auto";
			const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
			textarea.style.height = `${newHeight}px`;
			textarea.focus();
			const length = textarea.value.length;
			textarea.setSelectionRange(length, length);
		});
	}, [pendingPrompt, consumePendingPrompt, textareaRef]);

	const memoQuery = useMemo(() => {
		if (!input.startsWith("/")) return "";
		const match = input.match(/^\/(\S+)/);
		if (!match) return "";
		return match[1].toLowerCase();
	}, [input]);

	const filteredMemos = useMemo(() => {
		if (!memoQuery) return inputboxMemos.slice(0, 8);
		return inputboxMemos
			.filter((memo) =>
				displayTitleFromFilename(memo.filename).toLowerCase().includes(memoQuery.toLowerCase())
			)
			.slice(0, 8);
	}, [memoQuery, inputboxMemos]);

	const shouldShowDropdown = input.startsWith("/") && filteredMemos.length > 0;

	const addMemo = (memo: MemoItem) => {
		if (selectedMemos.length >= MAX_MEMOS) return;
		if (selectedMemos.find((m) => m.id === memo.id)) return;
		const newInput = input.replace(/^\/\S+\s*/, "");
		setInput(newInput);
		setSelectedMemos([...selectedMemos, memo]);
	};

	const removeMemo = (memoId: string) => {
		setSelectedMemos(selectedMemos.filter((m) => m.id !== memoId));
	};

	const adjustHeight = () => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
		textarea.style.height = `${newHeight}px`;
	};

	const handleSubmit = () => {
		if (!input || input.trim() === "" || isLoading) return;

		const citation = pendingCitation?.trim();
		const body = input.trim();
		const messageContent = citation
			? `<citation>\n${citation}\n</citation>\n\n${body}`
			: body;

		onSend(messageContent, {
			includeSelectedFile: false,
			memos: selectedMemos.length > 0 ? selectedMemos : undefined,
		});
		setInput("");
		setSelectedMemos([]);
		setPendingCitation(undefined);
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}
	};

	const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const value = e.target?.value ?? "";
		setInput(value);
		adjustHeight();
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (isComposing || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
		if (e.key === "Enter") {
			if (e.shiftKey) return;
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div className="px-4 pb-2.5 max-h-[45vh]">
			<div className="relative rounded-2xl border border-[var(--ring)]">
				<div className="px-3 pt-2 pb-1.5">
					{selectedMemos.length > 0 && (
						<div className="flex flex-wrap gap-1 mb-2">
							{selectedMemos.map((memo) => (
								<div
									key={memo.id}
									className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--secondary)] text-xs text-[var(--agent-foreground)]"
								>
									<span className="truncate max-w-[100px]">{displayTitleFromFilename(memo.filename)}</span>
									<button
										type="button"
										onClick={() => removeMemo(memo.id)}
										className="p-0.5 hover:bg-[var(--muted)] rounded"
										aria-label="移除 Memo"
									>
										<X className="w-3 h-3" />
									</button>
								</div>
							))}
						</div>
					)}
					{pendingCitation && (
						<CitationCard
							text={pendingCitation}
							extraClassName="mb-2"
							onDismiss={() => setPendingCitation(undefined)}
						/>
					)}
					<DropdownMenu open={shouldShowDropdown}>
						<DropdownMenuTrigger asChild>
							<div className="relative w-full">
								<AITextarea
									ref={textareaRef}
									value={input}
									onChange={handleChange}
									onKeyDown={handleKeyDown}
									onCompositionStart={() => setIsComposing(true)}
									onCompositionEnd={() => setIsComposing(false)}
									placeholder="问 AI 进行写作"
									disabled={isLoading}
									className="min-h-[44px] max-h-[180px] w-full overflow-auto resize-none border-0 p-0 bg-transparent placeholder:text-[var(--muted-foreground)] placeholder:opacity-60 focus:outline-none focus:ring-0 text-[15px]"
									style={{ fontFamily: "var(--agent-font)" }}
									rows={1}
								/>
							</div>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" side="top" className="w-[280px] max-h-[300px] overflow-y-auto">
							<DropdownMenuLabel className="flex items-center gap-1">
								<Hash className="w-3 h-3" />
								选择 Memo
								{memoQuery && <span className="text-muted-foreground">: {memoQuery}</span>}
							</DropdownMenuLabel>
							<DropdownMenuSeparator />
							{filteredMemos.map((memo) => (
								<DropdownMenuItem
									key={memo.id}
									onClick={() => addMemo(memo)}
									className="flex items-start gap-2 py-2 cursor-pointer"
								>
									<FileText className="w-4 h-4 mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
									<div className="flex-1 min-w-0">
										<div className="text-sm font-medium truncate">{displayTitleFromFilename(memo.filename)}</div>
										{memo.preview && (
											<div className="text-xs text-[var(--muted-foreground)] truncate">{memo.preview}</div>
										)}
									</div>
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					<div className="flex justify-between mt-1 -mx-1">
						<div className="flex items-center gap-0">
							{/* 一级弹窗: 跟 document-titlebar-shared 的「更多」同款
							    DropdownMenu ── 内容已经在 portal 里, 二级面板作为
							    `absolute right-full top-0` 的子节点直接挂在 trigger
							    wrapper 内, 不需要 createPortal / getBoundingClientRect
							    / stopImmediatePropagation 那一整套兼容层。 */}
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
										aria-label="添加上下文"
									>
										<Plus className="h-5 w-5" />
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" side="top" sideOffset={8} className="w-[220px] px-1 py-1.5">
									<InputboxAdd />
								</DropdownMenuContent>
							</DropdownMenu>
							{showModelMode && <CodexModelMenu />}
							{showPermissionMode && <PermissionModeMenu />}
						</div>
						{isLoading ? (
							<Tooltip content="停止生成">
								<Button
									type="button"
									size="icon"
									onClick={onStop}
									aria-label="停止生成"
									className="h-8 w-8 rounded-full bg-[var(--warning)] hover:bg-[var(--warning)] text-[var(--floating-foreground)]"
								>
									<Stop className="h-4 w-4" weight="fill" />
								</Button>
							</Tooltip>
						) : (
							<Tooltip content="发送">
								<Button
									type="submit"
									size="icon"
									disabled={!input || input.trim() === ""}
									onClick={handleSubmit}
									className="h-8 w-8 rounded-full bg-[var(--primary)] hover:bg-[var(--primary)] text-[var(--primary-foreground)] disabled:opacity-50 disabled:cursor-not-allowed"
									aria-label="发送"
								>
									<PaperPlaneRight className="h-5 w-5" />
								</Button>
							</Tooltip>
						)}
					</div>
				</div>
			</div>
		</div>
	);
});

BaseInputbox.displayName = "BaseInputbox";

export const FlowixInputbox = forwardRef<HTMLTextAreaElement, InputboxProps>((props, ref) => (
	<BaseInputbox {...props} ref={ref} showPermissionMode={false} />
));

FlowixInputbox.displayName = "FlowixInputbox";

export const CodexInputbox = forwardRef<HTMLTextAreaElement, InputboxProps>((props, ref) => (
	<BaseInputbox {...props} ref={ref} showModelMode showPermissionMode />
));

CodexInputbox.displayName = "CodexInputbox";

export const Inputbox = FlowixInputbox;
