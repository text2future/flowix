import { useRef, useEffect, useState } from "react";
import { ChatMessage as ChatMessageComponent } from "./chat-message";
import { CodexInputbox, FlowixInputbox } from "./agent-inputbox";
import { AgentWelcome } from "./agent-welcome";
import { ChatHistory } from "./chat-history";
import { AgentThinkingIndicator } from "./agent-thinking-indicator";
import { useChatStore } from "../../../lib/store/chat-store";
import { CaretDoubleRightIcon } from "@phosphor-icons/react";
import { aiConfig, windows } from "../../../lib/tauri/client";
import type { ChatMessage } from "../../../types";
import { ChevronDown } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { Tooltip } from "../../../components/ui/tooltip";
import { AGENT_ROLES, getAgentRole } from "../../../lib/agent-roles";

interface AgentRootProps {
	onSendMessage?: (content: string, options?: { includeSelectedFile?: boolean }) => void;
	onClosePanel?: () => void;
}

interface AgentHeaderProps {
	onClosePanel?: () => void;
	onSelectThread: (threadId: string) => void;
}

const IS_WINDOWS = /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);

function AgentRuntimeSwitcher() {
	const activeRoleKey = useChatStore((s) => s.activeAgentRoleKey);
	const setActiveAgentRoleKey = useChatStore((s) => s.setActiveAgentRoleKey);
	const current = getAgentRole(activeRoleKey);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="flex h-7 shrink-0 items-center justify-center gap-0 rounded-full border border-[var(--border)] px-1.5 hover:bg-[var(--muted)] [-webkit-app-region:no-drag]"
				>
					<img
						src={current.icon}
						alt={current.name}
						className="h-5 w-5 rounded object-contain"
					/>
					<ChevronDown className="h-3 w-3 text-[var(--muted-foreground)]" strokeWidth={2.5} />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-36 p-1">
				{AGENT_ROLES.map((item) => {
					const selected = item.key === activeRoleKey;
					return (
						<DropdownMenuItem
							key={item.key}
							onClick={() => setActiveAgentRoleKey(item.key)}
							className="flex cursor-pointer items-center gap-2"
						>
							<img
								src={item.icon}
								alt={item.name}
								className="h-4 w-4 rounded object-contain"
							/>
							<span>{item.name}</span>
							{selected && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function WindowsAgentHeader({ onClosePanel, onSelectThread }: AgentHeaderProps) {
	return (
		<div
			data-tauri-drag-region
			className="shrink-0 h-9 pl-2 pr-[126px] flex items-center gap-0"
		>
			{onClosePanel && (
				<Tooltip content="关闭面板">
					<button
						onClick={onClosePanel}
						className="w-6 h-8 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--agent-foreground)] rounded-lg transition-colors"
					>
						<CaretDoubleRightIcon className="w-4 h-4" weight="regular" />
					</button>
				</Tooltip>
			)}
			<AgentRuntimeSwitcher />
			<ChatHistory onSelectThread={onSelectThread} />
		</div>
	);
}

function MacAgentHeader({ onClosePanel, onSelectThread }: AgentHeaderProps) {
	return (
		<div
			data-tauri-drag-region
			className="shrink-0 h-12 px-2 flex items-center gap-0"
		>
			{onClosePanel && (
				<Tooltip content="关闭面板">
					<button
						onClick={onClosePanel}
						className="w-6 h-8 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--agent-foreground)] rounded-lg transition-colors"
					>
						<CaretDoubleRightIcon className="w-4 h-4" weight="regular" />
					</button>
				</Tooltip>
			)}
			<AgentRuntimeSwitcher />
			<ChatHistory onSelectThread={onSelectThread} />
		</div>
	);
}

/** 妯″潡绾у父閲忕┖鏁扮粍 鈹€鈹€ 缁?zustand selector 褰?fallback, 淇濊瘉杩斿洖寮曠敤
 * 绋冲畾, 涓嶄細瑙﹀彂 "selector 杩斿洖鏂板璞?鈫?re-render 鈫?鍐嶈繑鍥炴柊瀵硅薄"
 * 鐨勬棤闄愬惊鐜€?React 娓叉煋鐨?messages.map 鑻ユ嬁鍒版柊 `[]` 寮曠敤灏辫涓? * 鍒楄〃鍙樹簡, 绔嬪埢 re-render, selector 鍙堣繑鍥炴柊 `[]`, 姝诲惊鐜?鈹€鈹€ 杩欐槸
 * 鏀?threadStates 褰㈢姸鍚庢渶甯歌鐨勯櫡闃便€?涓嶅姞 readonly / freeze 鈹€鈹€
 * messages 鐨勪笅娓?(e.g. AgentChatRoot 鍐呯殑 .map) 鏈熸湜 ChatMessage[]
 * 鍙彉, 杩欓噷鍙槸鍏滃簳涓嶈 zustand 璇垽, 涓氬姟灞備笉 mutate 鍗冲彲銆?*/
const EMPTY_MESSAGES: ChatMessage[] = [];

export function AgentChatRoot({ onSendMessage, onClosePanel }: AgentRootProps) {
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// 浠呬綔涓?鏈厤缃?鈫?璺宠浆鍋忓ソ璁剧疆"鐨?gate, 涓嶅啀淇濈暀 agent instance:
	// 鍚庣 chat 鏃舵寜闇€璇?ai_config.json銆?
	const [isAgentConfigured, setIsAgentConfigured] = useState<boolean | null>(null);

	// 鈹€鈹€ 澶?thread 鍚庡彴骞惰: 鎵€鏈?state 浠?`threadStates[activeThreadId]`
	// 鍙? 缂虹渷鍥為€€鍒扮ǔ瀹氱┖寮曠敤, 涓嶅啀缁戝叏灞€椤跺眰瀛楁銆?鈹€鈹€
	//
	// 鈿?selector 蹇呴』杩斿洖绋冲畾寮曠敤 鈥斺€?	//  1. messages 璧?module-level `EMPTY_MESSAGES` 甯搁噺, 姘歌繙涓嶈兘 inline
	//     鍐?`?? []` `?? {}` 涔嬬被(姣忔杩斿洖鏂扮┖鏁扮粍 鈫?zustand 璇垽 鈫?	//     re-render 鈫?鍐嶈繑鍥炴柊绌烘暟缁?鈫?姝诲惊鐜?"Maximum update depth
	//     exceeded")銆?	//  2. 鏀?threadStates shape 鏃? 鑻ユ柊澧炲瓧娈靛悓鏍烽渶瑕?module-level
	//     绌哄父閲忓厹搴? 缁ф壙杩欎釜 pattern銆?
	const activeThreadId = useChatStore((s) =>
		getAgentRole(s.activeAgentRoleKey).runtime === "codex" ? s.activeCodexThreadId : s.activeThreadId
	);
	const messages = useChatStore((s) => {
		const tid = getAgentRole(s.activeAgentRoleKey).runtime === "codex" ? s.activeCodexThreadId : s.activeThreadId;
		return tid ? s.threadStates[tid]?.messages ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
	});
	const isLoading = useChatStore((s) => {
		const tid = getAgentRole(s.activeAgentRoleKey).runtime === "codex" ? s.activeCodexThreadId : s.activeThreadId;
		return tid ? s.threadStates[tid]?.isLoading ?? false : false;
	});
	const onSendMessageStore = useChatStore((s) => s.sendMessageStream);
	const stopMessageStream = useChatStore((s) => s.stopStream);
	const setPendingPrompt = useChatStore((s) => s.setPendingPrompt);
	const loadThread = useChatStore((s) => s.loadThread);
	const loadThreadList = useChatStore((s) => s.loadThreadList);
	const loadCodexThread = useChatStore((s) => s.loadCodexThread);
	const loadCodexThreadList = useChatStore((s) => s.loadCodexThreadList);
	const activeRoleKey = useChatStore((s) => s.activeAgentRoleKey);
	const activeRole = getAgentRole(activeRoleKey);

	// 鍚姩鏃舵帰涓€涓?ai_config.json 鏄惁宸插～ model 鈥?浠呭喅瀹氳涓嶈鐩存帴璺冲亸濂借缃?
	// 鐪熸鐨?provider 鐢卞悗绔湪 chat 鏃舵瀯寤恒€?
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const cfg = await aiConfig.get();
				if (!cancelled) {
					setIsAgentConfigured(Boolean(cfg.model?.model));
				}
			} catch {
				if (!cancelled) {
					setIsAgentConfigured(false);
				}
			}
		})();
		if (getAgentRole(useChatStore.getState().activeAgentRoleKey).runtime === "codex") {
			loadCodexThreadList();
		} else {
			loadThreadList();
		}
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (activeRole.runtime === "codex") {
			loadCodexThreadList();
		} else {
			loadThreadList();
		}
	}, [activeRole.runtime, loadCodexThreadList, loadThreadList]);

	// activeThreadId 鍙樺寲 鈫?閲嶆柊浠?SQLite 鎷変竴娆?(merge 杩涚幇鏈?in-memory
	// state, 涓嶄細瑕嗙洊姝ｅ湪璺戠殑 streaming chunk)銆?涓嶅啀渚濊禆鍏ㄥ眬 threadId銆?
	useEffect(() => {
		if (activeThreadId) {
			if (activeRole.runtime === "codex") {
				if (!activeThreadId.startsWith("codex-local-")) {
					loadCodexThread(activeThreadId);
				}
			} else {
				loadThread(activeThreadId);
			}
		}
	}, [activeThreadId, activeRole.runtime, loadCodexThread, loadThread]);

	// Scroll to bottom 鈥?but only when messages are being appended or
	// updated (streaming chunks / new sends). A wholesale replace from
	// `loadThread` (panel open or thread switch), `clearMessages`, or
	// `createThread` should NOT animate the viewport, otherwise the
	// smooth scroll makes the freshly laid-out content visibly
	// "compress then expand" while the browser travels to the end.
	// Distinguish the two by the first message id: a streaming/append
	// chain keeps the head stable, a replace swaps it out.
	// 鍙紦瀛橀鏉?id 鑰屴笉鏄暣鏁扮粍 鈥?ref 鍐欏叆鏄?O(1) 瀛楃涓? 涓嶇敤鍦?	// 姣?chunk hot path 涓婂仛 ChatMessage[] 鐨勫紩鐢ㄤ紶閫掋€?
	const prevFirstIdRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		const prevId = prevFirstIdRef.current;
		const nextId = messages[0]?.id;
		prevFirstIdRef.current = nextId;

		// Initial load into an empty panel: jump to the bottom
		// instantly (no smooth animation) so the user lands on the
		// latest message instead of the top of a long history.
		if (prevId === undefined && nextId !== undefined) {
			messagesEndRef.current?.scrollIntoView({ block: "end" });
			return;
		}
		// Cleared (new conversation / cleared thread): no scroll.
		if (nextId === undefined) return;
		// Wholesale replace (`loadThread` switched thread): first id
		// changed 鈫?user is browsing a different conversation, don't
		// yank the viewport.
		if (prevId !== nextId) return;

		// Streaming / new messages: smooth follow.
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	// 鎶婃枃鏈€佽繘 chat store 鐨?pendingPrompt, 鐢?Inputbox 鑷繁鐨?effect 璋?	// setInput 鍐欏叆鍙楁帶 state 鈥?鐩存帴鏀?DOM ref 浼氳 value={input} 鐨勫彈鎺?	// textarea 鍦ㄤ笅娆℃覆鏌撴椂鍥炴粴, 鍙戦€佹寜閽殑 disabled 涔熻涓嶅埌鍊笺€?
	const setInputValue = (value: string) => {
		setPendingPrompt(value);
	};

	const handleSendMessage = (content: string, options?: { includeSelectedFile?: boolean }) => {
		if (activeRole.runtime === "flowix" && isAgentConfigured === false) {
			windows.openPreferences("agent");
			return;
		}
		if (onSendMessage) {
			onSendMessage(content, options);
		} else {
			onSendMessageStore(content);
		}
	};

	const handleSelectThread = (threadId: string) => {
		if (activeRole.runtime === "codex") {
			loadCodexThread(threadId);
		} else {
			loadThread(threadId);
		}
	};

	return (
		<div className="flex flex-col h-full">
			{IS_WINDOWS ? (
				<WindowsAgentHeader onClosePanel={onClosePanel} onSelectThread={handleSelectThread} />
			) : (
				<MacAgentHeader onClosePanel={onClosePanel} onSelectThread={handleSelectThread} />
			)}

			<div className="flex-1 overflow-y-auto scrollbar overflow-x-hidden">
				{messages.length > 0 ? (
					<div className="space-y-1.5 px-6 py-4">
						{messages.map((message) => (
							<ChatMessageComponent key={message.id} message={message} />
						))}
						<div ref={messagesEndRef} />
					</div>
				) : (
					<AgentWelcome onSelectPrompt={setInputValue} />
				)}
			</div>

			{/* 搴曢儴 footer: 鎬濊€冧腑鎸囩ず鍣ㄦ寜闇€娓叉煋, 涓嶆祦寮忔椂瀹屽叏鑴辩甯冨眬,
			    瀹瑰櫒鑷劧鏀剁缉鍒?Inputbox 楂樺害銆?*/}
			<div className="shrink-0">
				{isLoading && <AgentThinkingIndicator />}
				{activeRole.runtime === "codex" ? (
					<CodexInputbox
						ref={textareaRef}
						onSend={handleSendMessage}
						isLoading={isLoading}
						onStop={stopMessageStream}
					/>
				) : (
					<FlowixInputbox
						ref={textareaRef}
						onSend={handleSendMessage}
						isLoading={isLoading}
						onStop={stopMessageStream}
					/>
				)}
			</div>
		</div>
	);
}
