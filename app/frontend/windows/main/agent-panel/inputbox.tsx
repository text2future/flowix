import React, { useState, useRef, forwardRef, useEffect, useMemo } from "react";
import { Plus, X, FileText, Hash, Quote } from "lucide-react";
import { PaperPlaneRight } from "@phosphor-icons/react";
import { AITextarea } from "../../../components/ui/textarea";
import { Button } from "../../../components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "../../../components/ui/popover";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { InputboxAdd } from "./inputbox-add";
import { type MemoItem } from "../../../lib/store";
import { useMemoStore } from "../../../lib/store";
import { useChatStore } from "../../../lib/store/chat-store";

interface InputboxProps {
	onSend: (content: string, options?: { includeSelectedFile?: boolean; memos?: MemoItem[] }) => void;
	isLoading?: boolean;
	onNewChat?: () => void;
}

const MIN_HEIGHT = 44;
const MAX_HEIGHT = 180;
const MAX_MEMOS = 10;

export const Inputbox = forwardRef<HTMLTextAreaElement, InputboxProps>((props, ref) => {
	const { onSend, isLoading, onNewChat } = props;
	const [input, setInput] = useState("");
	const [selectedMemos, setSelectedMemos] = useState<MemoItem[]>([]);
	const [inputboxMemos, setInputboxMemos] = useState<MemoItem[]>([]);
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

	// Consume any externally-staged prompt (e.g. from the editor selection
	// bubble menu) and reflect it into the controlled input value.
	useEffect(() => {
		if (pendingPrompt === undefined) return;
		setInput(pendingPrompt);
		consumePendingPrompt();
		// Defer to next frame so the textarea has been painted with the new
		// value before we measure its scrollHeight.
		requestAnimationFrame(() => {
			const textarea = textareaRef.current;
			if (!textarea) return;
			textarea.style.height = "auto";
			const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
			textarea.style.height = `${newHeight}px`;
			textarea.focus();
			// Place the caret at the end so the user can append a question
			// naturally after the staged content.
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
		return inputboxMemos.filter(m =>
			(m.filename || "").toLowerCase().includes(memoQuery) ||
			(m.filename || "").replace(".md", "").includes(memoQuery)
		).slice(0, 8);
	}, [memoQuery, inputboxMemos]);

	const shouldShowDropdown = input.startsWith("/") && filteredMemos.length > 0;

	const addMemo = (memo: MemoItem) => {
		if (selectedMemos.length >= MAX_MEMOS) return;
		if (selectedMemos.find(m => m.id === memo.id)) return;
		const newInput = input.replace(/^\/\S+\s*/, "");
		setInput(newInput);
		setSelectedMemos([...selectedMemos, memo]);
	};

	const removeMemo = (memoId: string) => {
		setSelectedMemos(selectedMemos.filter(m => m.id !== memoId));
	};

	const adjustHeight = () => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
		textarea.style.height = `${newHeight}px`;
	};

	const handleSubmit = () => {
		if (input && input.trim() !== "" && !isLoading) {
			// The citation (if any) is emitted in the user message wrapped in
			// `<citation>…</citation>` tags. We place it at the very top so the
			// AI sees the quoted context before the user's follow-up question.
			const citation = pendingCitation?.trim();
			const body = input.trim();
			const messageContent = citation
				? `<citation>\n${citation}\n</citation>\n\n${body}`
				: body;

			onSend(messageContent, {
				includeSelectedFile: false,
				memos: selectedMemos.length > 0 ? selectedMemos : undefined
			});
			setInput("");
			setSelectedMemos([]);
			setPendingCitation(undefined);
			textareaRef.current!.style.height = "auto";
		}
	};

	const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const value = e.target?.value ?? "";
		setInput(value);
		adjustHeight();
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if ((e as unknown as { isComposing: boolean }).isComposing) return;
		if (e.key === "Enter") {
			if (e.shiftKey) return;
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div className="px-4 pb-2.5 max-h-[45vh]">
			<div className="relative rounded-2xl border border-[var(--agent-input-border)] bg-[var(--agent-input-bg)]">
				<div className="px-3 pt-2 pb-1.5">
					{selectedMemos.length > 0 && (
						<div className="flex flex-wrap gap-1 mb-2">
							{selectedMemos.map((memo) => (
								<div
									key={memo.id}
									className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--accent)] text-xs text-[var(--foreground)]"
								>
									<span className="truncate max-w-[100px]">{memo.filename}</span>
									<button
										type="button"
										onClick={() => removeMemo(memo.id)}
										className="p-0.5 hover:bg-[var(--muted)] rounded"
									>
										<X className="w-3 h-3" />
									</button>
								</div>
							))}
						</div>
					)}
					{pendingCitation && (
						<div className="citation-card mb-2 w-full" title={pendingCitation}>
							<Quote className="citation-card-icon" />
							<span className="citation-card-text">{pendingCitation}</span>
							<button
								type="button"
								aria-label="移除引用"
								className="citation-card-close"
								onClick={() => setPendingCitation(undefined)}
							>
								<X className="w-3 h-3" />
							</button>
						</div>
					)}
					<DropdownMenu open={shouldShowDropdown}>
						<DropdownMenuTrigger asChild>
							<div className="relative w-full">
								<AITextarea
									ref={textareaRef}
									value={input}
									onChange={handleChange}
									onKeyDown={handleKeyDown}
									placeholder="Ask me anything .."
									disabled={isLoading}
									className="min-h-[44px] max-h-[180px] w-full overflow-auto resize-none border-0 p-0 bg-transparent placeholder:text-gray-600 placeholder:opacity-60 focus:outline-none focus:ring-0 text-[15px]"
									style={{ fontFamily: 'var(--agent-font)' }}
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
										<div className="text-sm font-medium truncate">{memo.filename}</div>
										{memo.preview && (
											<div className="text-xs text-[var(--muted-foreground)] truncate">{memo.preview}</div>
										)}
									</div>
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					<div className="flex justify-between mt-1 -mx-1">
						<Popover>
							<PopoverTrigger asChild>
								<button
									type="button"
									className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--muted-foreground)] hover:bg-white/10"
									aria-label="Add"
								>
									<Plus className="h-5 w-5" />
								</button>
							</PopoverTrigger>
							<PopoverContent align="start" side="top" sideOffset={8}>
								<InputboxAdd onNewChat={onNewChat} />
							</PopoverContent>
						</Popover>
						<Button
							type="submit"
							size="icon"
							disabled={isLoading || !input || input.trim() === ""}
							onClick={handleSubmit}
							className="h-8 w-8 rounded-full bg-[var(--primary)] hover:bg-[var(--primary)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
						>
							<PaperPlaneRight className="h-5 w-5" />
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
});
