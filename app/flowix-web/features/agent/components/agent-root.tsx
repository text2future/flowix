import { useRef, useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChatMessage as ChatMessageComponent } from "@features/agent/components/chat-message";
import { CodexInputbox, FlowixInputbox } from "@features/agent/components/agent-inputbox";
import { AgentWelcome } from "@features/agent/components/agent-welcome";
import { ChatHistory } from "@features/agent/components/chat-history";
import { AgentThinkingIndicator } from "@features/agent/components/agent-thinking-indicator";
import { useChatStore } from "@features/agent/store/chat-store";
import { CaretDoubleRightIcon } from "@phosphor-icons/react";
import { aiConfig, windows } from "@platform/tauri/client";
import type { ChatMessage } from "@/types";
import { ChevronDown } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@shared/ui/dropdown-menu";
import { Tooltip } from "@shared/ui/tooltip";
import { AGENT_ROLES, getAgentRole } from "@/lib/agent-roles";

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
	// Layer 3: 虚拟滚动 ── scrollRef 既作 useVirtualizer 的 getScrollElement,
	// 也用于自动滚动 (替代旧 messagesEndRef.scrollIntoView 路径).
	const scrollRef = useRef<HTMLDivElement>(null);
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
	const loadMoreHistory = useChatStore((s) => s.loadMoreHistory);
	const hasMoreHistory = useChatStore((s) => {
		const tid =
			getAgentRole(s.activeAgentRoleKey).runtime === "codex"
				? s.activeCodexThreadId
				: s.activeThreadId;
		return tid ? s.threadStates[tid]?.hasMoreHistory ?? false : false;
	});
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
	// Layer 3: 用户手动向上滚后不强制 follow 到底 ── 距离底部 < 120px
	// 视作"还在底部", 流式时自动 follow; 否则保持视口不动. 120px 比
	// 80px 宽松一点是给"用户刚滑动了一下还没到内容深处"留缓冲.
	const FOLLOW_BOTTOM_THRESHOLD_PX = 120;
	const isNearBottomRef = useRef(true);

	// Layer 3: useVirtualizer 动态测量. estimateSize=140 是常见单条消息
	// 平均高度的保守估计 (短文本 60-100px, 中等 markdown 150-300px,
	// 工具调用单行 ~40px). overscan=8 给上下各预渲 8 条, 平滑滚动
	// 不出现空白. measureElement 自动跟踪每条实际高度 ── 流式时
	// pending assistant 高度持续变化也能自动 re-layout, lazy 加载的
	// 代码块完成后高度跳变同样会被自动重测.
	const virtualizer = useVirtualizer({
		count: messages.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 140,
		overscan: 8,
		measureElement: (el) => el.getBoundingClientRect().height,
		// 用 message id 作 key, 切换 thread 时 React 能正确复用 / 卸载
		// 虚拟项. 默认是 index, 在 prepend (Layer 4 分页) 场景下 index
		// 会偏移导致全部重新挂载, 用 id 避免.
		getItemKey: (index) => messages[index]?.id ?? index,
	});

	useEffect(() => {
		const prevId = prevFirstIdRef.current;
		const nextId = messages[0]?.id;
		prevFirstIdRef.current = nextId;

		// Initial load into an empty panel: jump to the bottom
		// instantly (no smooth animation) so the user lands on the
		// latest message instead of the top of a long history.
		if (prevId === undefined && nextId !== undefined) {
			virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
			isNearBottomRef.current = true;
			return;
		}
		// Cleared (new conversation / cleared thread): no scroll.
		if (nextId === undefined) return;
		// Wholesale replace (`loadThread` switched thread): first id
		// changed 鈫?user is browsing a different conversation, don't
		// yank the viewport.
		if (prevId !== nextId) return;

		// Streaming / new messages: smooth follow.
		// Layer 3: 仅当用户在底部附近时 follow, 否则保持视口不动.
		if (isNearBottomRef.current) {
			virtualizer.scrollToIndex(messages.length - 1, {
				align: "end",
				behavior: "smooth",
			});
		}
	}, [messages, virtualizer]);

	// Layer 3: 监听 scroll 事件, 维护 isNearBottomRef. 用 passive listener,
	// 直接读 scrollTop / scrollHeight / clientHeight, 不进 React state ──
	// 避免每次滚动都触发 re-render.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const handler = () => {
			const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
			isNearBottomRef.current = distance < FOLLOW_BOTTOM_THRESHOLD_PX;
		};
		el.addEventListener("scroll", handler, { passive: true });
		// 初始判定一次, 避免首屏未触发 scroll 时 isNearBottomRef 默认值
		// 与实际位置不符.
		handler();
		return () => el.removeEventListener("scroll", handler);
	}, []);

	// Layer 4: 顶部触达检测 + prepend 后视口稳定.
	// 触发条件: 滚动距离顶部 < 200px AND has-more AND 当前是 flowix runtime
	// (codex 走独立 codex_thread_get, 本期不分页).
	//
	// 视口稳定算法: prepend 前快照 scrollHeight → prepend 完成 resolve 后,
	// 新 scrollHeight 增大, 把当前 scrollTop 也按相同 delta 推下, 用户视口
	// 里看到的内容位置不变. requestAnimationFrame 让 react-virtual 先把新
	// 虚拟项 measure 好再写 scrollTop, 否则会跳一下.
	//
	// **F-1 修复 (thread-switch race)**: handler 启动时 `activeThreadId` 闭
	// 包捕获的是 effect setup 时的值. IPC in-flight 期间用户切 thread/role
	// 会导致 rAF 回调里 `el` 已是新 thread 的 scroll container, 此时再写
	// `el.scrollTop` 会把新 thread 的视口推到错位置. 修复: 在 `.then` 与
	// rAF 回调里用 `useChatStore.getState()` 直读最新 active thread, 与
	// 触发时的 tidAtCall 比对, 不一致就 bail.
	//
	// **F-2 修复 (rapid-fire scroll / scroll-during-IPC)**: 之前快照了
	// `beforeScrollTop` 并在 rAF 写回 `beforeScrollTop + delta`. 但若 IPC
	// 期间用户滚了几 px (触屏 / 鼠标惯性), 用陈旧的 beforeScrollTop 算
	// 出的新 scrollTop 会"甩"用户, 视觉上短暂跳一下. 修复: 不快照
	// scrollTop, rAF 内现读 `el.scrollTop + delta`, 把视口锚到"当前看到
	// 的内容 + delta 偏移", 在用户停在顶部 / 滚到中间 / 自动 follow 到底
	// 三种情况下都自然正确. 多次触发的并发由 `loadMoreHistory` 自身的
	// `loadingMore` 守门保证只有一个 fetch 跑 ── 其它 handler 调用走
	// `loadMoreHistory` 立即返 false, 不调度 rAF.
	const PREFETCH_TOP_THRESHOLD_PX = 200;
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		// codex runtime 不分页 ── Layer 4 仅对 flowix 后端做了 SQL 分页, codex
		// 走 codex_history::get_session 仍是全量, 不必拦截.
		if (activeRole.runtime === "codex") return;

		const handler = () => {
			if (el.scrollTop > PREFETCH_TOP_THRESHOLD_PX) return;
			if (!hasMoreHistory) return;
			if (!activeThreadId) return;

			const tidAtCall = activeThreadId;
			const beforeScrollHeight = el.scrollHeight;

			// F-1: 直读 store 最新 active thread, 不依赖闭包 ── 闭包里的
			// `activeThreadId` 是 effect 重建时捕获的旧值, IPC in-flight
			// 期间用户切 thread 不会反映到这里. 用 `getState()` 拿实时值.
			const isStillOnSameThread = (): boolean => {
				const s = useChatStore.getState();
				const role = getAgentRole(s.activeAgentRoleKey);
				const currentTid =
					role.runtime === "codex" ? s.activeCodexThreadId : s.activeThreadId;
				return currentTid === tidAtCall;
			};

			void loadMoreHistory(tidAtCall).then((loaded) => {
				if (!loaded) return;
				if (!isStillOnSameThread()) return;
				// 等一帧让 react-virtual 应用新 messages → 重新 measure 虚拟项 → 总高度更新.
				requestAnimationFrame(() => {
					if (!isStillOnSameThread()) return;
					const afterScrollHeight = el.scrollHeight;
					const delta = afterScrollHeight - beforeScrollHeight;
					if (delta > 0) {
						// F-2: 不用陈旧 beforeScrollTop, 用当前 scrollTop + delta ──
						// 视口锚到"用户当前看到的内容", 不甩回 IPC 前的位置.
						el.scrollTop = el.scrollTop + delta;
					}
				});
			});
		};
		el.addEventListener("scroll", handler, { passive: true });
		// 初次进入也判定一次 (短 thread 可能首屏就触顶, 自动加载更多).
		handler();
		return () => el.removeEventListener("scroll", handler);
	}, [activeThreadId, activeRole.runtime, hasMoreHistory, loadMoreHistory]);


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

			<div
				ref={scrollRef}
				className="flex-1 overflow-y-auto scrollbar overflow-x-hidden"
			>
				{messages.length > 0 ? (
					// Layer 3: 虚拟滚动容器. 外层 div 高度 = virtualizer.getTotalSize(),
					// 内部用 absolute + transform 定位每个虚拟项 ── DOM 节点数从
					// O(N) 降到 O(overscan + visible) ≈ 20 左右, 1MB 历史 (~500 条)
					// 首屏从 1.5-4s 降到 <200ms.
					//
					// padding 处理: 横向 px-6 留在外层 scroll 容器 (不影响虚拟化
					// 高度); 纵向 py-4 + 行间距 space-y-1.5 通过给虚拟内层
					// 顶 / 底 padding + 每项 wrapper 加 pb-1.5 等效模拟. 不直接
					// 用 padding 包裹虚拟项, 否则 absolute 定位会被 padding 偏移
					// 顶掉, getTotalSize 算出来的总高与实际不一致.
					<div className="px-6">
						<div
							style={{
								height: virtualizer.getTotalSize() + 32, // +32 = py-4 上下各 16px
								position: "relative",
								paddingTop: 16,
							}}
						>
							{virtualizer.getVirtualItems().map((vi) => {
								const message = messages[vi.index];
								if (!message) return null;
								return (
									<div
										key={vi.key}
										data-index={vi.index}
										ref={virtualizer.measureElement}
										style={{
											position: "absolute",
											top: 0,
											left: 0,
											width: "100%",
											transform: `translateY(${vi.start + 16}px)`,
											paddingBottom: 6, // ≈ space-y-1.5 (0.375rem)
										}}
									>
										<ChatMessageComponent message={message} />
									</div>
								);
							})}
						</div>
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
