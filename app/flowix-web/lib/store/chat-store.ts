import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatMessage, ThreadListItem } from '../../types';
import type { AgentChunk, AgentCodexModel, AgentPermissionMode, AgentRoleKey, AgentRuntime } from '../../types/agent';
import { STORAGE_KEYS } from '../constants';
import { agent, listenToAgentStream } from '../tauri/client';
import { useMemoStore } from './memo-store';
import { useDocumentStore } from './document-store';
import { isEmptyAssistantMessage } from '../message/empty';
import { stripSystemBlock } from '../message/system';
import { DEFAULT_AGENT_ROLE_KEY, getAgentRole, getAgentRoleByRuntime, normalizeAgentRoleKey } from '../agent-roles';

function joinPath(basePath: string, filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/') || filePath.startsWith('\\')) {
    return filePath;
  }
  return `${basePath.replace(/[\\/]+$/, '')}\\${filePath.replace(/^[\\/]+/, '')}`;
}

function buildDirectoryReminder(directory: string, notePath?: string): string {
  const noteLine = notePath ? `\n当前笔记：${notePath}` : '';
  return `<system-reminder>\n当前目录：${directory}${noteLine}\n</system-reminder>`;
}

function buildUserLlmContent(content: string, messages: ChatMessage[]): {
  llmContent: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
} {
  const memoState = useMemoStore.getState();
  const documentState = useDocumentStore.getState();
  const currentDirectory = memoState.selectedNotebook?.path?.trim();
  if (!currentDirectory) {
    return { llmContent: content };
  }

  const currentNotePath = documentState.currentDocumentPath?.trim()
    || (memoState.selectedMemo?.filename ? joinPath(currentDirectory, memoState.selectedMemo.filename) : undefined);

  const lastReminderMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user' && message.systemReminderDirectory);

  if (
    lastReminderMessage?.systemReminderDirectory === currentDirectory &&
    lastReminderMessage.systemReminderDocumentPath === currentNotePath
  ) {
    return { llmContent: content };
  }

  return {
    llmContent: `${content}\n\n${buildDirectoryReminder(currentDirectory, currentNotePath)}`,
    systemReminderDirectory: currentDirectory,
    systemReminderDocumentPath: currentNotePath,
  };
}

function toToolInput(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return undefined;
}

function buildThreadTitle(content: string): string {
  const title = content.replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 28) : '新对话';
}

function userMessageStableKey(message: ChatMessage): string | null {
  if (message.role !== 'user') return null;
  return JSON.stringify({
    role: message.role,
    content: message.content,
    llmContent: message.llmContent,
    systemReminderDirectory: message.systemReminderDirectory,
    systemReminderDocumentPath: message.systemReminderDocumentPath,
  });
}

function userMessageVisibleKey(message: ChatMessage): string | null {
  if (message.role !== 'user') return null;
  return JSON.stringify({
    role: message.role,
    visibleContent: stripSystemBlock(message.content || ''),
  });
}

function mergeHistoricalMessages(existing: ChatMessage[], historical: ChatMessage[]): ChatMessage[] {
  if (existing.length === 0) return historical;

  const seenIds = new Set(existing.map((message) => message.id));
  const existingUserCounts = new Map<string, number>();
  const existingVisibleUserCounts = new Map<string, number>();
  for (const message of existing) {
    const key = userMessageStableKey(message);
    if (key) {
      existingUserCounts.set(key, (existingUserCounts.get(key) ?? 0) + 1);
    }

    const visibleKey = userMessageVisibleKey(message);
    if (visibleKey) {
      existingVisibleUserCounts.set(visibleKey, (existingVisibleUserCounts.get(visibleKey) ?? 0) + 1);
    }
  }

  const missing: ChatMessage[] = [];
  for (const message of historical) {
    if (seenIds.has(message.id)) continue;

    const key = userMessageStableKey(message);
    if (key) {
      const count = existingUserCounts.get(key) ?? 0;
      if (count > 0) {
        existingUserCounts.set(key, count - 1);
        const visibleKey = userMessageVisibleKey(message);
        if (visibleKey) {
          const visibleCount = existingVisibleUserCounts.get(visibleKey) ?? 0;
          if (visibleCount > 0) {
            existingVisibleUserCounts.set(visibleKey, visibleCount - 1);
          }
        }
        continue;
      }
    }

    const visibleKey = userMessageVisibleKey(message);
    if (visibleKey) {
      const count = existingVisibleUserCounts.get(visibleKey) ?? 0;
      if (count > 0) {
        existingVisibleUserCounts.set(visibleKey, count - 1);
        continue;
      }
    }

    missing.push(message);
  }

  return [...existing, ...missing];
}

/**
 * 每个 thread 独立的运行态 ── 不再绑在"当前 active thread"上, 让 A
 * 对话在后台跑 / B 对话在前面写 / 重入 A 看到全部最新消息都能成立。
 *
 * 真源仍是 SQLite (`threadStates` 是实时增量缓存, 不进 zustand persist),
 * 切走时不需要做任何清理; 重入 thread 时调 `loadThread(tid)` 重新从
 * 磁盘 seed 一次, 再叠加 `stream_start/end` 之间的实时 chunk。
 *
 * `pendingAssistantId` / `pendingReasoningId` 是 dispatchAgentChunk
 * 内部的临时游标 ── 给 applyTextChunk / applyReasoningChunk 知道
 * 下一个 text/reasoning chunk 应该 append 到哪一行。流结束 / tool_call
 * 时归零。 业务 UI 不读这两个字段。
 */
export interface ThreadState {
  messages: ChatMessage[];
  isLoading: boolean;
  pendingAssistantId: string | null;
  pendingReasoningId: string | null;
}

function emptyThreadState(): ThreadState {
  return {
    messages: [],
    isLoading: false,
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

/** 派发器使用的局部 mutable 别名 ── 避免到处写 `as ThreadState`。 */
type ThreadsMap = Record<string, ThreadState>;

export interface ChatStore {
  threadStates: ThreadsMap;
  activeThreadId: string | undefined;
  activeCodexThreadId: string | undefined;
  activeAgentRoleKey: AgentRoleKey;
  agentRuntime: AgentRuntime;
  threadRoles: Record<string, AgentRoleKey>;
  agentPermissionMode: AgentPermissionMode;
  agentCodexModel: AgentCodexModel;
  threadList: ThreadListItem[];
  codexThreadList: ThreadListItem[];
  currentThreadTitle: string | undefined;
  currentCodexThreadTitle: string | undefined;
  /**
   * One-shot prompt staged by external callers (e.g. the editor selection bubble
   * menu) for the inputbox to pick up on the next render. Cleared as soon as
   * the inputbox consumes it via `consumePendingPrompt`.
   */
  pendingPrompt: string | undefined;
  /**
   * One-shot citation staged alongside the prompt — rendered as a card above
   * the input area and emitted in the outgoing user message wrapped in
   * `<citation>…</citation>` tags. Cleared on send or on dismiss.
   */
  pendingCitation: string | undefined;

  // ── actions ──
  setThreadList: (list: ThreadListItem[]) => void;
  setCurrentThreadTitle: (title: string | undefined) => void;
  /**
   * 切换 active thread ── Agent 面板 / 各种组件读 activeThreadId 来决定
   * '当前显示哪个 thread'。纯前端切换, 不发 IPC, 不动 threadStates ── 跟
   * `loadThread` 的区别: loadThread 还会拉 threadInfo 设置 currentThreadTitle,
   * 这里只切 active, 适合'我已经知道 threadId, 只想切过去显示'的场景
   * (例如 AgentThreadCard 的 openPanelButton: 用户点开卡片的头部气泡
   * 时, 把这个 thread 设成 active, 同时打开面板)。
   */
  setActiveThreadId: (threadId: string | undefined) => void;
  setActiveCodexThreadId: (threadId: string | undefined) => void;
  setActiveAgentRoleKey: (roleKey: AgentRoleKey) => void;
  setActiveAgentThread: (roleKey: AgentRoleKey, threadId: string | undefined) => void;
  bindThreadRole: (threadId: string, roleKey: AgentRoleKey) => void;
  setAgentRuntime: (runtime: AgentRuntime) => void;
  setAgentPermissionMode: (mode: AgentPermissionMode) => void;
  setAgentCodexModel: (model: AgentCodexModel) => void;
  setPendingPrompt: (prompt: string | undefined) => void;
  consumePendingPrompt: () => string | undefined;
  setPendingCitation: (citation: string | undefined) => void;
  consumePendingCitation: () => string | undefined;
  loadThreadList: () => Promise<void>;
  loadThread: (threadId: string) => Promise<void>;
  loadCodexThreadList: () => Promise<void>;
  loadCodexThread: (threadId: string) => Promise<void>;
  loadThreadCache: (threadId: string) => Promise<void>;
  createThread: (title?: string) => Promise<void>;
  createCodexThread: () => void;
  deleteThread: (threadId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  sendMessageToThread: (threadId: string, content: string, roleKey?: AgentRoleKey) => Promise<void>;
  sendMessageStream: (content: string) => Promise<void>;
  /**
   * 终止当前 active thread 的 in-flight chat_stream ── 后端 cancel
   * flag 翻转后, `chat_stream` 走 flush_cancel 退出, 触发 `StreamEnd`
   * chunk, `dispatchAgentChunk` 收敛 isLoading。 这里只负责发信号,
   * UI 状态由 chunk 事件收敛。
   */
  stopStream: () => Promise<void>;
  /**
   * 全局 `agent-chunk` 派发器 ── 由 `useAgentEvents` 在 App.tsx 顶层
   * 挂的 listener 调一次, 按 `chunk.thread_id` 路由到 `threadStates[tid]`。
   * 这是后台多 chat 并行的核心: 一个 listener, 多个 thread_state,
   * chunk 自带 thread_id 自然分流。
   */
  dispatchAgentChunk: (chunk: AgentChunk) => void;
  /**
   * 启动时 seed 用: 把后端 `agent_running_threads` 返回的 keys 写入
   * 对应 `threadStates[tid].isLoading = true`。 仅在 App.tsx 挂载
   * 时调一次, 让"上次进程在跑的 chat"在重启后 UI 仍可见。
   */
  seedRunningThreads: (running: Record<string, { startedAt: number }>) => void;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => {
      // 首次 send 时若没有 active thread, 先创建一个。 thread 不再绑定 agent 信息 ─
      // 后端按需读 ~/.flowix/flowix-ai-config.toml, 取消了 agent_id 透传。
      const ensureThread = async (content: string): Promise<string> => {
        const role = getAgentRole(get().activeAgentRoleKey);
        if (role.runtime === 'codex') {
          const existingCodexThreadId = get().activeCodexThreadId;
          if (existingCodexThreadId) {
            get().bindThreadRole(existingCodexThreadId, role.key);
            return existingCodexThreadId;
          }
          const threadId = `codex-local-${Date.now()}`;
          set((state) => ({
            activeCodexThreadId: threadId,
            activeAgentRoleKey: role.key,
            agentRuntime: role.runtime,
            currentCodexThreadTitle: buildThreadTitle(content),
            threadRoles: {
              ...state.threadRoles,
              [threadId]: role.key,
            },
            threadStates: {
              ...state.threadStates,
              [threadId]: state.threadStates[threadId] ?? emptyThreadState(),
            },
          }));
          return threadId;
        }

        const existingThreadId = get().activeThreadId;
        if (existingThreadId) {
          get().bindThreadRole(existingThreadId, role.key);
          return existingThreadId;
        }

        const thread = await agent.createThread(buildThreadTitle(content));
        set((state) => {
          const nextStates: ThreadsMap = {
            ...state.threadStates,
            [thread.threadId]: state.threadStates[thread.threadId] ?? emptyThreadState(),
          };
          return {
            activeThreadId: thread.threadId,
            activeAgentRoleKey: role.key,
            agentRuntime: role.runtime,
            currentThreadTitle: thread.title,
            threadRoles: {
              ...state.threadRoles,
              [thread.threadId]: role.key,
            },
            threadStates: nextStates,
          };
        });
        await get().loadThreadList();
        return thread.threadId;
      };

      return {
        threadStates: {},
        activeThreadId: undefined,
        activeCodexThreadId: undefined,
        activeAgentRoleKey: DEFAULT_AGENT_ROLE_KEY,
        agentRuntime: 'flowix',
        threadRoles: {},
        agentPermissionMode: 'inherit',
        agentCodexModel: 'inherit',
        threadList: [],
        codexThreadList: [],
        currentThreadTitle: undefined,
        currentCodexThreadTitle: undefined,
        pendingPrompt: undefined,
        pendingCitation: undefined,

        setThreadList: (list) => set({ threadList: list }),
        setCurrentThreadTitle: (title) => set({ currentThreadTitle: title }),
        setActiveThreadId: (threadId) => set((state) => ({
          activeThreadId: threadId,
          activeAgentRoleKey: 'flowix',
          agentRuntime: 'flowix',
          ...(threadId
            ? { threadRoles: { ...state.threadRoles, [threadId]: 'flowix' } }
            : {}),
        })),
        setActiveCodexThreadId: (threadId) => set((state) => ({
          activeCodexThreadId: threadId,
          activeAgentRoleKey: 'codex',
          agentRuntime: 'codex',
          ...(threadId
            ? { threadRoles: { ...state.threadRoles, [threadId]: 'codex' } }
            : {}),
        })),
        setActiveAgentRoleKey: (roleKey) => {
          const role = getAgentRole(roleKey);
          set({ activeAgentRoleKey: role.key, agentRuntime: role.runtime });
        },
        setActiveAgentThread: (roleKey, threadId) => {
          const role = getAgentRole(roleKey);
          set((state) => ({
            activeAgentRoleKey: role.key,
            agentRuntime: role.runtime,
            ...(role.runtime === 'codex'
              ? { activeCodexThreadId: threadId }
              : { activeThreadId: threadId }),
            ...(threadId
              ? { threadRoles: { ...state.threadRoles, [threadId]: role.key } }
              : {}),
          }));
        },
        bindThreadRole: (threadId, roleKey) => {
          const role = getAgentRole(roleKey);
          set((state) => ({
            threadRoles: {
              ...state.threadRoles,
              [threadId]: role.key,
            },
          }));
        },
        setAgentRuntime: (runtime) => {
          const role = getAgentRoleByRuntime(runtime);
          set({ activeAgentRoleKey: role.key, agentRuntime: role.runtime });
        },
        setAgentPermissionMode: (mode) => set({ agentPermissionMode: mode }),
        setAgentCodexModel: (model) => set({ agentCodexModel: model }),
        setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
        consumePendingPrompt: () => {
          const { pendingPrompt } = get();
          if (pendingPrompt !== undefined) {
            set({ pendingPrompt: undefined });
          }
          return pendingPrompt;
        },
        setPendingCitation: (citation) => set({ pendingCitation: citation }),
        consumePendingCitation: () => {
          const { pendingCitation } = get();
          if (pendingCitation !== undefined) {
            set({ pendingCitation: undefined });
          }
          return pendingCitation;
        },

        loadThreadList: async () => {
          try {
            const threads = await agent.listThreads();
            set({ threadList: threads });
          } catch (err) {
            console.error('Failed to load thread list:', err);
          }
        },

        loadThread: async (threadId) => {
          try {
            const thread = await agent.getThread(threadId);
            const threadInfo =
              get().threadList.find((item) => item.threadId === threadId) ??
              (await agent.listThreads()).find((item) => item.threadId === threadId);
            // Drop empty assistant messages that older sessions may have
            // persisted — they render as blank cards and add no value.
            const messages = thread.messages.filter((m) => !isEmptyAssistantMessage(m));
            set((state) => {
              const existing = state.threadStates[threadId] ?? emptyThreadState();
              // 以 `message.id` 去重 merge ── 若该 thread 当前正在跑
              // (isLoading=true), listener 已经在写 threadStates, 这里
              // 不能整体替换 (会把 listener 写的 in-flight chunk 覆盖
              // 掉); 只补齐 SQLite 里有但 store 里没有的"历史行"。
              const merged = mergeHistoricalMessages(existing.messages, messages);
              return {
                activeThreadId: threadId,
                activeAgentRoleKey: 'flowix',
                agentRuntime: 'flowix',
                threadRoles: {
                  ...state.threadRoles,
                  [threadId]: state.threadRoles[threadId] ?? 'flowix',
                },
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...existing,
                    messages: merged,
                  },
                },
                currentThreadTitle: threadInfo?.title ?? '未命名对话',
              };
            });
          } catch (err) {
            console.error('Failed to load thread:', err);
          }
        },

        loadCodexThreadList: async () => {
          try {
            const threads = await agent.listCodexThreads();
            set({ codexThreadList: threads });
          } catch (err) {
            console.error('Failed to load Codex thread list:', err);
          }
        },

        loadCodexThread: async (threadId) => {
          try {
            const thread = await agent.getCodexThread(threadId);
            const threadInfo =
              get().codexThreadList.find((item) => item.threadId === threadId) ??
              (await agent.listCodexThreads()).find((item) => item.threadId === threadId);
            const messages = thread.messages.filter((m) => !isEmptyAssistantMessage(m));
            set((state) => {
              const existing = state.threadStates[threadId] ?? emptyThreadState();
              return {
                activeCodexThreadId: threadId,
                activeAgentRoleKey: 'codex',
                agentRuntime: 'codex',
                threadRoles: {
                  ...state.threadRoles,
                  [threadId]: state.threadRoles[threadId] ?? 'codex',
                },
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...existing,
                    messages,
                    pendingAssistantId: null,
                    pendingReasoningId: null,
                  },
                },
                currentCodexThreadTitle: threadInfo?.title ?? 'Codex Session',
              };
            });
          } catch (err) {
            console.error('Failed to load Codex thread:', err);
          }
        },

        loadThreadCache: async (threadId) => {
          try {
            const thread = await agent.getThread(threadId);
            const messages = thread.messages.filter((m) => !isEmptyAssistantMessage(m));
            set((state) => {
              const existing = state.threadStates[threadId] ?? emptyThreadState();
              const merged = mergeHistoricalMessages(existing.messages, messages);

              return {
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...existing,
                    messages: merged,
                  },
                },
              };
            });
          } catch (err) {
            console.error('Failed to load thread cache:', err);
          }
        },

        createThread: async (title = '新对话') => {
          try {
            const thread = await agent.createThread(title);
            set((state) => ({
              activeThreadId: thread.threadId,
              activeAgentRoleKey: 'flowix',
              agentRuntime: 'flowix',
              currentThreadTitle: thread.title,
              threadRoles: {
                ...state.threadRoles,
                [thread.threadId]: 'flowix',
              },
              threadStates: {
                ...state.threadStates,
                [thread.threadId]: state.threadStates[thread.threadId] ?? emptyThreadState(),
              },
            }));
            await get().loadThreadList();
          } catch (err) {
            console.error('Failed to create thread:', err);
          }
        },

        createCodexThread: () => {
          const threadId = `codex-local-${Date.now()}`;
          set((state) => ({
            activeCodexThreadId: threadId,
            activeAgentRoleKey: 'codex',
            agentRuntime: 'codex',
            currentCodexThreadTitle: 'Codex Session',
            threadRoles: {
              ...state.threadRoles,
              [threadId]: 'codex',
            },
            threadStates: {
              ...state.threadStates,
              [threadId]: state.threadStates[threadId] ?? emptyThreadState(),
            },
          }));
        },

        deleteThread: async (threadId) => {
          try {
            await agent.deleteThread(threadId);
            set((state) => {
              // 注意: 不删 threadStates[threadId] ── 若它此刻还在跑
              // (isLoading=true), 删了 store 状态, listener 写入时会
              // 重新创建空 state 然后继续写; 视觉上短暂"消失"再"出现"
              // 不优雅。 保留 in-memory state, 反正进程退出就清空。
              // 真源 SQLite 已经删了, 重启后也不会再有该 thread 的
              // threadStates 项。
              const { [threadId]: _removed, ...rest } = state.threadStates;
              return {
                threadList: state.threadList.filter((t) => t.threadId !== threadId),
                threadStates: rest,
                ...(state.activeThreadId === threadId
                  ? {
                      activeThreadId: undefined,
                      currentThreadTitle: undefined,
                    }
                  : {}),
              };
            });
          } catch (err) {
            console.error('Failed to delete thread:', err);
          }
        },

        sendMessage: async (content) => {
          return get().sendMessageStream(content);
        },

        sendMessageToThread: async (threadId, content, roleKey) => {
          const trimmed = content.trim();
          if (!threadId || !trimmed) return;
          const role = getAgentRole(
            roleKey ?? get().threadRoles[threadId] ?? get().activeAgentRoleKey
          );
          get().bindThreadRole(threadId, role.key);

          const currentMessages = get().threadStates[threadId]?.messages ?? [];
          const userPayload = buildUserLlmContent(trimmed, currentMessages);
          const userMessage: ChatMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: trimmed,
            llmContent: userPayload.llmContent,
            systemReminderDirectory: userPayload.systemReminderDirectory,
            systemReminderDocumentPath: userPayload.systemReminderDocumentPath,
            timestamp: new Date().toISOString(),
          };

          set((state) => {
            const st = state.threadStates[threadId] ?? emptyThreadState();
            return {
              threadStates: {
                ...state.threadStates,
                [threadId]: {
                  ...st,
                  messages: [...st.messages, userMessage],
                  pendingAssistantId: null,
                  pendingReasoningId: null,
                },
              },
            };
          });

          try {
            const permissionMode = get().agentPermissionMode;
            const codexModel = get().agentCodexModel;
            await agent.chatStream(threadId, {
              content: trimmed,
              llmContent: userPayload.llmContent,
              systemReminderDirectory: userPayload.systemReminderDirectory,
              systemReminderDocumentPath: userPayload.systemReminderDocumentPath,
              runtime: role.runtime,
              permissionMode,
              codexModel,
            });
          } catch (err) {
            console.error('Failed to dispatch thread card chat_stream:', err);
            const errorMessage: ChatMessage = {
              id: `error-${Date.now()}`,
              role: 'assistant',
              content:
                typeof err === 'string' && err
                  ? err
                  : '抱歉，发送失败。',
              timestamp: new Date().toISOString(),
            };
            set((state) => {
              const st = state.threadStates[threadId] ?? emptyThreadState();
              return {
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...st,
                    isLoading: false,
                    messages: [...st.messages, errorMessage],
                  },
                },
              };
            });
          }
        },

        sendMessageStream: async (content) => {
          // 关键: 这条函数不再注册 listener (由 App.tsx 顶层挂的全局
          // listener 统一接收), 也不再 set isLoading=true (由
          // `stream_start` chunk 收敛)。 这里只负责: 建 user message,
          // 调后端 IPC 触发 spawn, 后端一切错误/完成信号走 chunk 事件。
          const activeRole = getAgentRole(get().activeAgentRoleKey);
          const { activeThreadId, activeCodexThreadId, threadStates } = get();
          const activeId = activeRole.runtime === 'codex' ? activeCodexThreadId : activeThreadId;
          const currentState = activeId ? threadStates[activeId] : undefined;
          const isFirstMessage = !currentState || currentState.messages.length === 0;

          let effectiveThreadId: string;
          try {
            effectiveThreadId = await ensureThread(content);
          } catch (err) {
            console.error('Failed to ensure thread:', err);
            return;
          }

          // user message 直接进对应 thread 的 messages, 不再读全局
          // `messages` ── 后端会 persist 这一行, listener 不会重发。
          const userPayload = buildUserLlmContent(
            content,
            get().threadStates[effectiveThreadId]?.messages ?? []
          );
          const userMessage: ChatMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content,
            llmContent: userPayload.llmContent,
            systemReminderDirectory: userPayload.systemReminderDirectory,
            systemReminderDocumentPath: userPayload.systemReminderDocumentPath,
            timestamp: new Date().toISOString(),
          };
          set((state) => {
            const tid = effectiveThreadId;
            const st = state.threadStates[tid] ?? emptyThreadState();
            return {
              threadStates: {
                ...state.threadStates,
                [tid]: {
                  ...st,
                  messages: [...st.messages, userMessage],
                  pendingAssistantId: null,
                  pendingReasoningId: null,
                },
              },
            };
          });

          // 独立于 ensureThread 的首条消息重命名 ── 与旧版同形。
          if (isFirstMessage && activeRole.runtime === 'flowix') {
            const previousTitle = get().currentThreadTitle;
            const nextTitle = buildThreadTitle(content);
            const isPlaceholderTitle = (t: string | undefined) =>
              !t || t === '新对话';
            const shouldRename =
              nextTitle !== previousTitle &&
              (nextTitle !== '新对话' || isPlaceholderTitle(previousTitle));
            if (shouldRename) {
              set({ currentThreadTitle: nextTitle });
              agent
                .updateThreadTitle(effectiveThreadId, nextTitle)
                .then(() => get().loadThreadList())
                .catch((err) => console.error('Failed to update thread title:', err));
            }
          }

          // 触发后端 ── 立即返回 (后端 fire-and-forget), 不需要 await
          // 任何结果。 任何错误 / 完成信号都走 `agent-chunk` 事件,
          // 由 dispatchAgentChunk 收敛 isLoading / 错误卡片。
          try {
            const permissionMode = get().agentPermissionMode;
            const codexModel = get().agentCodexModel;
            await agent.chatStream(effectiveThreadId, {
              content,
              llmContent: userPayload.llmContent,
              systemReminderDirectory: userPayload.systemReminderDirectory,
              systemReminderDocumentPath: userPayload.systemReminderDocumentPath,
              runtime: activeRole.runtime,
              permissionMode,
              codexModel,
            });
          } catch (err) {
            // IPC 本身抛错 (例如后端 spawn 失败 / 命令未注册) ── 这种
            // 错误不走 chunk 路径, 走 catch 这里手动 emit 一条 error
            // 卡片并 isLoading=false。 正常情况下不会走到这里, 因为
            // chat_stream 现在立即 Ok 返回, 不会抛 Err。
            console.error('Failed to dispatch chat_stream:', err);
            const errorMessage: ChatMessage = {
              id: `error-${Date.now()}`,
              role: 'assistant',
              content:
                typeof err === 'string' && err
                  ? err
                  : '抱歉，发生了错误。',
              timestamp: new Date().toISOString(),
            };
            set((state) => {
              const tid = effectiveThreadId;
              const st = state.threadStates[tid] ?? emptyThreadState();
              return {
                threadStates: {
                  ...state.threadStates,
                  [tid]: {
                    ...st,
                    isLoading: false,
                    messages: [...st.messages, errorMessage],
                  },
                },
              };
            });
          }
        },

        stopStream: async () => {
          const role = getAgentRole(get().activeAgentRoleKey);
          const { activeThreadId, activeCodexThreadId } = get();
          const activeId = role.runtime === 'codex' ? activeCodexThreadId : activeThreadId;
          if (!activeId) return;
          try {
            await agent.stopChatStream(activeId);
          } catch (err) {
            console.error('Failed to stop stream:', err);
          }
          // 不手动 set isLoading=false ── 等后端 `flush_cancel` 走完后
          // emit `StreamEnd` chunk, dispatchAgentChunk 收敛。 这样跨
          // 后台 / 前台 thread 行为统一, 不会出现"后端还在 flush 但 UI
          // 已经停了"的撕裂。
        },

        dispatchAgentChunk: (chunk) => {
          set((state) => {
            const tid = chunk.thread_id;
            const st = state.threadStates[tid] ?? emptyThreadState();
            switch (chunk.kind) {
              case 'stream_start':
                return {
                  threadStates: {
                    ...state.threadStates,
                    [tid]: { ...st, isLoading: true },
                  },
                };
              case 'stream_end':
                return {
                  threadStates: {
                    ...state.threadStates,
                    [tid]: {
                      ...st,
                      isLoading: false,
                      pendingAssistantId: null,
                      pendingReasoningId: null,
                    },
                  },
                };
              case 'text': {
                // 跳过纯空白 chunk ── 与旧 chat-store.ts:322 同形。
                if (!chunk.text || !chunk.text.trim()) return state;
                const next = applyTextChunk(st, chunk.text);
                return {
                  threadStates: {
                    ...state.threadStates,
                    [tid]: {
                      ...st,
                      messages: next.messages,
                      pendingAssistantId: next.pendingAssistantId,
                      pendingReasoningId: null, // text 落地后 reasoning 行 closed
                    },
                  },
                };
              }
              case 'reasoning': {
                const next = applyReasoningChunk(st, chunk.text);
                return {
                  threadStates: {
                    ...state.threadStates,
                    [tid]: {
                      ...st,
                      messages: next.messages,
                      pendingReasoningId: next.pendingReasoningId,
                    },
                  },
                };
              }
              case 'tool_call': {
                const next = applyToolCallChunk(st, chunk.id, chunk.name, chunk.input);
                return {
                  threadStates: {
                    ...state.threadStates,
                    [tid]: {
                      ...st,
                      messages: next.messages,
                      pendingAssistantId: null, // tool_call 之后到 tool_result 之前的 assistant 行不连续, 重置
                    },
                  },
                };
              }
              case 'tool_result': {
                const next = applyToolResultChunk(st, chunk.id, chunk.name, chunk.result);
                return {
                  threadStates: {
                    ...state.threadStates,
                    [tid]: { ...st, messages: next.messages },
                  },
                };
              }
              case 'error': {
                const next = applyErrorChunk(st, chunk.message);
                return {
                  threadStates: {
                    ...state.threadStates,
                    [tid]: { ...st, messages: next.messages },
                  },
                };
              }
            }
          });
        },

        seedRunningThreads: (running) => {
          set((state) => {
            const next: ThreadsMap = { ...state.threadStates };
            for (const tid of Object.keys(running)) {
              const existing = next[tid] ?? emptyThreadState();
              next[tid] = { ...existing, isLoading: true };
            }
            return { threadStates: next };
          });
        },
      };
    },
    {
      name: STORAGE_KEYS.CHAT,
      // 不 persist `threadStates` ── 真源是 SQLite, 缓存持久化反而
      // 引入双源漂移。 仅 persist `activeThreadId` (启动时跳到上次
      // active thread) + `currentThreadTitle` (UI 立即显示, 避免空白)。
      partialize: (state) => ({
        activeThreadId: state.activeThreadId,
        activeCodexThreadId: state.activeCodexThreadId,
        activeAgentRoleKey: state.activeAgentRoleKey,
        threadRoles: state.threadRoles,
        currentThreadTitle: state.currentThreadTitle,
        currentCodexThreadTitle: state.currentCodexThreadTitle,
        agentRuntime: state.agentRuntime,
        agentPermissionMode: state.agentPermissionMode,
        agentCodexModel: state.agentCodexModel,
      }),
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<ChatStore> | undefined;
        const roleKey = normalizeAgentRoleKey(
          persistedState?.activeAgentRoleKey ??
          (persistedState?.agentRuntime
            ? getAgentRoleByRuntime(persistedState.agentRuntime).key
            : current.activeAgentRoleKey)
        );
        return {
          ...current,
          ...persistedState,
          activeAgentRoleKey: roleKey,
          agentRuntime: getAgentRole(roleKey).runtime,
          threadRoles: persistedState?.threadRoles ?? current.threadRoles,
        };
      },
    }
  )
);

// ============================================================
// chunk apply helpers (pure functions, 方便后续单测)
// ============================================================

/** Apply chunk 返回的 partial state ── 包含新 messages 和需要更新的
 * pending id 字段。 这样 helper 不用直接 mutate ThreadState, 保持纯
 * 函数 (后续可单测)。 */
interface ApplyResult {
  messages: ChatMessage[];
  pendingAssistantId: string | null;
  pendingReasoningId: string | null;
}

/** 在 `text` chunk 上做 append ── 与旧 chat-store.ts:319-348 同形,
 * 但操作的是 ThreadState.messages 而不是全局 messages。 */
function applyTextChunk(st: ThreadState, text: string): ApplyResult {
  // reasoning 行已经在上一次 text 落地时 closed (isCompleted: true)
  // ── 与旧 store 同形, 见 chat-store.ts:325-330。
  const closedMessages = st.pendingReasoningId
    ? st.messages.map((m) =>
        m.id === st.pendingReasoningId ? { ...m, isCompleted: true } : m
      )
    : st.messages;
  if (!st.pendingAssistantId) {
    const id = `assistant-${Date.now()}`;
    return {
      messages: [
        ...closedMessages,
        {
          id,
          role: 'assistant',
          content: text,
          timestamp: new Date().toISOString(),
        },
      ],
      pendingAssistantId: id,
      pendingReasoningId: null,
    };
  }
  return {
    messages: closedMessages.map((m) =>
      m.id === st.pendingAssistantId ? { ...m, content: m.content + text } : m
    ),
    pendingAssistantId: st.pendingAssistantId,
    pendingReasoningId: null,
  };
}

function applyReasoningChunk(st: ThreadState, text: string): ApplyResult {
  if (!st.pendingReasoningId) {
    const id = `reasoning-${Date.now()}`;
    return {
      messages: [
        ...st.messages,
        {
          id,
          role: 'reasoning',
          content: text,
          timestamp: new Date().toISOString(),
          isCompleted: false,
        },
      ],
      pendingReasoningId: id,
      pendingAssistantId: st.pendingAssistantId,
    };
  }
  return {
    messages: st.messages.map((m) =>
      m.id === st.pendingReasoningId ? { ...m, content: m.content + text } : m
    ),
    pendingReasoningId: st.pendingReasoningId,
    pendingAssistantId: st.pendingAssistantId,
  };
}

function applyToolCallChunk(
  st: ThreadState,
  id: string,
  name: string,
  input: unknown
): ApplyResult {
  const toolMessage: ChatMessage = {
    id: `tool-${id || Date.now()}`,
    role: 'tool',
    content: '',
    timestamp: new Date().toISOString(),
    toolCallId: id,
    toolName: name,
    toolInput: toToolInput(input),
    isLoading: true,
  };
  return {
    messages: [...st.messages, toolMessage],
    pendingAssistantId: null,
    pendingReasoningId: st.pendingReasoningId,
  };
}

function applyToolResultChunk(
  st: ThreadState,
  id: string,
  name: string,
  result: unknown
): ApplyResult {
  const resultContent = JSON.stringify(result ?? {}, null, 2);
  return {
    messages: st.messages.map((m) =>
      m.role === 'tool' && m.toolCallId === id
        ? {
            ...m,
            content: resultContent,
            toolData: resultContent,
            toolName: name || m.toolName || '',
            isLoading: false,
          }
        : m
    ),
    pendingAssistantId: st.pendingAssistantId,
    pendingReasoningId: st.pendingReasoningId,
  };
}

function applyErrorChunk(st: ThreadState, message: string): ApplyResult {
  return {
    messages: [
      ...st.messages,
      {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: message,
        timestamp: new Date().toISOString(),
      },
    ],
    pendingAssistantId: st.pendingAssistantId,
    pendingReasoningId: st.pendingReasoningId,
  };
}

// ============================================================
// 顶层 listener 注册 ── App.tsx 一次性挂载, 不再走 sendMessageStream。
// ============================================================
//
// 这段 IIFE 模块加载时跑, 把 `dispatchAgentChunk` 桥接到 listenToAgentStream。
// 与旧版 `sendMessageStream` 内每次挂 listener 不同, 现在是模块级单例:
// - 两窗口 (主窗口 / 偏好窗口) 都 import 这个模块, 但 listenToAgentStream
//   内部用 `streamUnlisten` 短路, 第二个调用直接 return ── 不会重复挂载。
// - `useAgentEvents` 在 App.tsx 顶层显式挂一次, 卸载时 unlisten。
// - `dispatchAgentChunk` 通过 zustand store 派发, 跨组件共享状态。
//
// 这里保留一段 `installAgentChunkBridge` 暴露, 给 `useAgentEvents` 调用;
// 内部直接 import store 派发, 避免 `client.ts` 反向依赖 store (会形成
// 循环引用: store → client → store)。

let bridgeInstalled = false;
export function installAgentChunkBridge(): void {
  if (bridgeInstalled) return;
  bridgeInstalled = true;
  void listenToAgentStream((chunk) => {
    useChatStore.getState().dispatchAgentChunk(chunk);
  });
}
