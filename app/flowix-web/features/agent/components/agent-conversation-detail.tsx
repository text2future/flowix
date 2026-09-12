'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import backgroundImage from '@/assets/bg.document.png';
import { DEFAULT_AGENT_TYPE_KEY } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { agent } from '@platform/tauri/client/agent';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { useMemoStore } from '@features/memo/store/memo-store';
import { acquireThreadInterest } from '@features/agent/store/thread-interest';
import type { ThreadState } from '@features/agent/store/thread-runtime-state';
import {
  AgentThreadCardMessagesController,
  createThreadCacheSkeleton,
} from '@features/agent/thread-card/messages';
import {
  ComposerController,
  ComposerDraftController,
  ComposerImageController,
  ComposerAddMenuController,
  createAgentComposerDom,
  disposeAgentComposerDom,
  getAgentThreadCardUserHistoryMessagesFromMessages,
} from '@features/agent/thread-card/composer';
import { AgentRolePickerController } from '@features/agent/thread-card/role/agent-role-picker-controller';
import { ExternalAgentSettingsController } from '@features/agent/thread-card/settings/external-agent-settings-controller';
import { CodexSettingsDialogController } from '@features/agent/thread-card/settings/codex-settings-dialog';
import { AgentConversationSurfaceController } from '@features/agent/thread-card/surface/agent-conversation-surface-controller';
import { createExternalAgentRuntimeHandle } from '@features/agent/services/external-agent-runtime-service';
import { ensureAgentConversationDetailThread } from '@features/agent/components/agent-conversation-detail-submit';
import { markConversationWorkspaceStarted } from '@features/agent/runtime/workspace-snapshot';
import { ensureConversationWorkspaceSnapshot } from '@features/agent/runtime/workspace-snapshot';
import { AgentBackgroundTerminals } from '@features/agent/components/agent-background-terminals';
import { buildInitialInstanceRuntimeConfig } from '@features/agent/store/initial-runtime-config';
import { defaultThreadTitle } from '@features/agent/store/thread-titles';
import { selectAndOpenAgentConversation } from '@features/workspace/use-cases/agent-conversation-navigation';
import { openPath, openUrl } from '@platform/tauri/opener';
import { dialogs } from '@platform/tauri/client/desktop';
import { isEditableTextFilePath } from '@features/editor/code-file';
import { openNoteByDeepLink } from '@features/memo/use-cases/open-by-target';
import {
  agentFileScopePathForRuntime,
  localFilePathFromAgentHref,
} from '@features/agent/thread-card/link-navigation';
import {
  openBrowserColumnFileBrowser,
  openBrowserColumnText,
  openBrowserColumnWebpage,
} from '@features/workspace/use-cases/browser-column-navigation';
import {
  runDshCommand,
  hasPendingDshCommand,
  listDshSkills,
} from '@features/agent/services/dsh-command-service';
import {
  beginCodexSlashCommand,
  createCodexCommandLifecycle,
  executeCodexSlashCommand,
  finishCodexSlashCommand,
  hasPendingCodexCommand,
  listCodexSkills,
} from '@features/agent/services/codex-slash-command-service';
import { isCodexGoalCommand } from '@features/agent/thread-card/agent-thread-card-selectors';
import { getAgentConversationRuntimeCwd } from '@features/agent/conversation-presentation';

const BOTTOM_FOLLOW_THRESHOLD_PX = 96;
const TOP_HISTORY_LOAD_THRESHOLD_PX = 48;
const SCROLL_DELTA_EPSILON_PX = 0.5;
const INPUT_DRAFT_MAX_CHARS = 500;
const EMPTY_MESSAGES: ThreadState['messages'] = [];
const EMPTY_PENDING_CODEX_MESSAGES: readonly [] = [];
const DETAIL_DRAFT_KEY_PREFIX = 'flowix:agent-conversation-draft:';
const logger = createLogger('agent-conversation-detail');

function shouldShowInitialHistorySkeleton(
  threadId: string | null,
  messageCount: number,
  status: 'idle' | 'loading' | 'ready' | 'error' | undefined,
): boolean {
  return Boolean(threadId)
    && messageCount === 0
    && status !== 'ready'
    && status !== 'error';
}

function detailDraftKey(instanceId: string): string {
  return `${DETAIL_DRAFT_KEY_PREFIX}${instanceId}`;
}

function readDetailDraft(instanceId: string): string {
  try {
    return window.localStorage.getItem(detailDraftKey(instanceId)) ?? '';
  } catch {
    return '';
  }
}

function persistDetailDraft(instanceId: string, draft: string | null): void {
  try {
    if (draft) window.localStorage.setItem(detailDraftKey(instanceId), draft);
    else window.localStorage.removeItem(detailDraftKey(instanceId));
  } catch {
    // Draft persistence is a convenience; a blocked storage backend must not
    // prevent an existing conversation from being resumed.
  }
}

/**
 * A document-independent host for an existing agent thread.
 *
 * Unlike the first implementation, this surface now uses the exact same
 * message viewport and composer controllers as the note-embedded Thread Card.
 * ProseMirror-only concerns (node attrs, collapse and delete) deliberately
 * remain in AgentThreadCardView; this host keeps the shared conversation
 * chrome, including title editing, above its message viewport.
 */
export function AgentConversationDetail({
  instanceId,
}: {
  instanceId: string;
}) {
  const { language, t } = useI18n();
  const instance = useAgentSessionStore((state) => state.getInstance(instanceId));
  const threadId = instance?.threadId ?? null;
  const renderThreadId = threadId;
  const projection = useAgentSessionStore((state) => (
    renderThreadId ? state.threadProjections[renderThreadId] : undefined
  ));
  const messages = projection?.messages ?? EMPTY_MESSAGES;
  const isLoading = !!projection?.runs.isLoading;
  const isDshCommandRunning = projection?.runs.dshCommand?.status === 'pending';
  const isCodexCommandRunning = projection?.runs.codexCommand?.status === 'pending';
  const isCodexCommandStoppable =
    isCodexCommandRunning && isCodexGoalCommand(projection?.runs.codexCommand?.command);
  const isCommandRunning = isDshCommandRunning || isCodexCommandRunning;
  const pendingSteeringMessages = useAgentSessionStore((state) =>
    threadId
      ? state.pendingSteeringMessages[threadId] ?? EMPTY_PENDING_CODEX_MESSAGES
      : EMPTY_PENDING_CODEX_MESSAGES,
  );
  const initialHistoryStatus = projection?.pagination.initialStatus ?? 'idle';
  const isInitialHistoryLoading = shouldShowInitialHistorySkeleton(
    threadId,
    messages.length,
    initialHistoryStatus,
  );
  const domRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerMountRef = useRef<HTMLDivElement>(null);
  const loadingIndicatorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const messagesControllerRef = useRef<AgentThreadCardMessagesController | null>(null);
  const composerControllerRef = useRef<ComposerController | null>(null);
  const composerImagesControllerRef = useRef<ComposerImageController | null>(null);
  const externalSettingsRef = useRef<ExternalAgentSettingsController | null>(null);
  const rolePickerRef = useRef<AgentRolePickerController | null>(null);
  const addMenuRef = useRef<ComposerAddMenuController | null>(null);
  const codexSettingsDialogRef = useRef<CodexSettingsDialogController | null>(null);
  const surfaceRef = useRef<AgentConversationSurfaceController | null>(null);
  const draftRef = useRef<string | null>(null);
  const destroyedRef = useRef(false);
  const renderThreadIdRef = useRef<string | null>(renderThreadId);
  const typeKeyRef = useRef<AgentTypeKey>(instance?.agentType ?? DEFAULT_AGENT_TYPE_KEY);
  const messagesRef = useRef(messages);
  const isLoadingRef = useRef(isLoading);
  const isDshCommandRunningRef = useRef(isDshCommandRunning);
  const isCodexCommandRunningRef = useRef(isCodexCommandRunning);
  const isCodexCommandStoppableRef = useRef(isCodexCommandStoppable);
  const instanceRef = useRef(instance);
  const threadIdRef = useRef(threadId);
  const runtimeHandleRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const languageRef = useRef(language);
  const tRef = useRef(t);
  const submitRef = useRef<() => void>(() => undefined);
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);

  const forkFromMessage = useCallback(async (message: ThreadState['messages'][number]) => {
    const currentInstance = instanceRef.current;
    const sourceThreadId = threadIdRef.current;
    const agentType = currentInstance?.agentType;
    if (!currentInstance || !sourceThreadId || (agentType !== 'codex' && agentType !== 'deepseek-harness')) return;
    if (agentType === 'codex' && !message.codexTurnId) return;
    if (agentType === 'deepseek-harness' && message.sourceSequence === undefined) return;

    if (destroyedRef.current) return;

    try {
      const result = agentType === 'codex'
        ? await agent.forkCodexThread(sourceThreadId, message.codexTurnId!)
        : await agent.forkDeepSeekHarnessThread(sourceThreadId, message.sourceSequence!);
      const fork = useAgentSessionStore.getState().createInstance({
        agentType,
        title: `${currentInstance.title || defaultThreadTitle(agentType)} (fork)`,
        threadId: result.thread.threadId,
        runtimeConfig: currentInstance.runtimeConfig ?? buildInitialInstanceRuntimeConfig(agentType),
        source: { kind: 'dedicated', notebookId: currentInstance.source.notebookId ?? null },
        role: currentInstance.role ?? undefined,
      });
      await selectAndOpenAgentConversation(fork.instanceId);
    } catch (error) {
      logger.error(`Failed to fork ${agentType} conversation`, { error });
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

  renderThreadIdRef.current = renderThreadId;
  typeKeyRef.current = instance?.agentType ?? DEFAULT_AGENT_TYPE_KEY;
  messagesRef.current = messages;
  isLoadingRef.current = isLoading;
  isDshCommandRunningRef.current = isDshCommandRunning;
  isCodexCommandRunningRef.current = isCodexCommandRunning;
  isCodexCommandStoppableRef.current = isCodexCommandStoppable;
  instanceRef.current = instance;
  threadIdRef.current = threadId;
  languageRef.current = language;
  tRef.current = t;

  const clearComposerAfterSlashCommand = useCallback(() => {
    composerControllerRef.current?.clear();
    composerControllerRef.current?.clearDraft();
    composerImagesControllerRef.current?.clearAfterSubmit();
    persistDetailDraft(instanceId, null);
    composerControllerRef.current?.updateMultiLineState();
  }, [instanceId]);

  const ensureDshCommandConversation = useCallback(async (command: string) => {
    if (typeKeyRef.current !== 'deepseek-harness') {
      throw new Error('This slash command is only available for DSH');
    }
    const currentInstance = instanceRef.current;
    if (!currentInstance) throw new Error('Agent session instance was not found');
    const currentThreadId = threadIdRef.current;
    if (!currentThreadId) {
      if (!runtimeHandleRef.current) {
        runtimeHandleRef.current = createExternalAgentRuntimeHandle();
      }
      const ensured = await ensureAgentConversationDetailThread({
        instanceId: currentInstance.instanceId,
        typeKey: 'deepseek-harness',
        prompt: command,
        runtimeHandleId: runtimeHandleRef.current,
      });
      threadIdRef.current = ensured.threadId;
      return {
        threadId: ensured.threadId,
        runtimeConfig: ensured.runtimeConfig,
      };
    }
    const runtimeConfig = ensureConversationWorkspaceSnapshot(currentInstance.instanceId);
    markConversationWorkspaceStarted(currentInstance.instanceId);
    return { threadId: currentThreadId, runtimeConfig };
  }, []);

  const ensureCodexCommandConversation = useCallback(async (command: string) => {
    if (typeKeyRef.current !== 'codex') {
      throw new Error('This slash command is only available for Codex');
    }
    const currentInstance = instanceRef.current;
    if (!currentInstance) throw new Error('Agent session instance was not found');
    let currentThreadId = threadIdRef.current;
    if (!currentThreadId) {
      if (!runtimeHandleRef.current) {
        runtimeHandleRef.current = createExternalAgentRuntimeHandle();
      }
      const ensured = await ensureAgentConversationDetailThread({
        instanceId: currentInstance.instanceId,
        typeKey: 'codex',
        prompt: command,
        runtimeHandleId: runtimeHandleRef.current,
      });
      currentThreadId = ensured.threadId;
      threadIdRef.current = currentThreadId;
      return {
        threadId: currentThreadId,
        runtimeConfig: ensured.runtimeConfig,
      };
    }
    const runtimeConfig = ensureConversationWorkspaceSnapshot(currentInstance.instanceId);
    markConversationWorkspaceStarted(currentInstance.instanceId);
    return { threadId: currentThreadId, runtimeConfig };
  }, []);

  const runDshCommandFromDetail = useCallback(async (command: string, imagePaths: string[] = []) => {
    if (destroyedRef.current || typeKeyRef.current !== 'deepseek-harness') return;
    await runDshCommand({
      command,
      imagePaths,
      ensureConversation: ensureDshCommandConversation,
      onError: (message) => toast.error(message),
      onLogError: (message, error) => logger.error(message, { error }),
      onSaveExport: async (filename, content) => {
        const target = await dialogs.saveFile(
          filename,
          [{ name: 'JSON', extensions: ['json'] }],
        );
        if (!target) return;
        const written = await dialogs.writeExportFile(target, content);
        toast[written ? 'success' : 'error'](
          written ? 'DSH 会话已导出。' : 'DSH 会话导出失败。',
        );
      },
      onFocus: () => {
        if (!destroyedRef.current) composerControllerRef.current?.focus();
      },
      sendFailedText: tRef.current('agent.chat.sendFailed'),
    });
  }, [ensureDshCommandConversation]);

  const runCodexSlashCommandFromDetail = useCallback(async (command: string) => {
    if (destroyedRef.current || typeKeyRef.current !== 'codex') return;
    if (hasPendingCodexCommand(threadIdRef.current)) return;
    let lifecycle: ReturnType<typeof createCodexCommandLifecycle> | undefined;
    let commandThreadId: string | null = null;
    try {
      let currentThreadId = threadIdRef.current;
      let cwd = getAgentConversationRuntimeCwd(instanceRef.current);
      if (!currentThreadId) {
        const currentInstance = instanceRef.current;
        if (!currentInstance) throw new Error('Agent session instance was not found');
        if (!runtimeHandleRef.current) {
          runtimeHandleRef.current = createExternalAgentRuntimeHandle();
        }
        const ensured = await ensureAgentConversationDetailThread({
          instanceId: currentInstance.instanceId,
          typeKey: 'codex',
          prompt: command,
          runtimeHandleId: runtimeHandleRef.current,
        });
        currentThreadId = ensured.threadId;
        threadIdRef.current = currentThreadId;
        cwd = ensured.runtimeConfig.workspaceSnapshot?.cwd ?? ensured.runtimeConfig.cwd ?? cwd;
      }
      commandThreadId = currentThreadId;
      lifecycle = createCodexCommandLifecycle(currentThreadId);
      beginCodexSlashCommand(currentThreadId, command, lifecycle);
      await executeCodexSlashCommand(currentThreadId, command, cwd, lifecycle);
      await useAgentSessionStore.getState().loadMessages('codex', currentThreadId);
    } catch (error) {
      if (lifecycle && commandThreadId) {
        finishCodexSlashCommand(
          commandThreadId,
          command,
          lifecycle,
          'error',
          error instanceof Error ? error.message : String(error),
        );
      }
      logger.error('Failed to execute Codex slash command', { error });
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (!destroyedRef.current) composerControllerRef.current?.focus();
    }
  }, []);

  const submit = useCallback(async () => {
    // 线程绑定是异步的; submittingRef 挡住"创建中"期间的重入。Codex
    // 和 DSH 已有运行时允许本次提交转入当前 turn 的 steering 队列，
    // 其它 agent 仍等待当前运行结束。
    const isSteerable = typeKeyRef.current === 'codex' || typeKeyRef.current === 'deepseek-harness';
    if (submittingRef.current || (isLoadingRef.current && !isSteerable)) return;
    const composerController = composerControllerRef.current;
    const currentInstance = instanceRef.current;
    if (
      (typeKeyRef.current === 'deepseek-harness' && hasPendingDshCommand(currentInstance?.threadId)) ||
      (typeKeyRef.current === 'codex' && hasPendingCodexCommand(currentInstance?.threadId))
    ) return;
    const content = composerController?.getPrompt().trim() ?? '';
    const imagePaths = composerImagesControllerRef.current?.readyImages.map((image) => image.path) ?? [];
    if (!composerController || (!content && imagePaths.length === 0) || !currentInstance) return;

    if (
      typeKeyRef.current === 'deepseek-harness' &&
      /^\/(?:goal|plan)(?:\s|$)/iu.test(content)
    ) {
      clearComposerAfterSlashCommand();
      void runDshCommandFromDetail(content, imagePaths);
      return;
    }
    if (typeKeyRef.current === 'codex' && /^\/(?:compact|goal)(?:\s|$)/iu.test(content)) {
      clearComposerAfterSlashCommand();
      void runCodexSlashCommandFromDetail(content);
      return;
    }

    submittingRef.current = true;
    try {
      let targetThreadId = threadIdRef.current;
      let conversationTitle = currentInstance.title;
      let runtimeConfig = currentInstance.runtimeConfig ?? null;
      const isFirstMessage = !targetThreadId;

      if (!targetThreadId) {
        // 空独立对话的首条消息: 先绑定产品线程 (flowix -> createThread;
        // 外部 CLI -> local thread id), 再冻结 workspace snapshot, 最后才 dispatch。
        if (!runtimeHandleRef.current) {
          runtimeHandleRef.current = createExternalAgentRuntimeHandle();
        }
        const ensured = await ensureAgentConversationDetailThread({
          instanceId: currentInstance.instanceId,
          typeKey: currentInstance.agentType,
          prompt: content || 'Analyze the attached image(s).',
          runtimeHandleId: runtimeHandleRef.current,
        });
        targetThreadId = ensured.threadId;
        conversationTitle = ensured.title;
        runtimeConfig = ensured.runtimeConfig;
      }

      composerController.clear();
      persistDetailDraft(currentInstance.instanceId, null);
      composerController.resetHistoryNavigation();
      composerController.clearDraft();
      composerController.updateMultiLineState();
      composerImagesControllerRef.current?.clearAfterSubmit();
      await useAgentSessionStore.getState().sendMessageToThread(
        targetThreadId,
        content || 'Analyze the attached image(s).',
        currentInstance.agentType,
        {
          instanceId: currentInstance.instanceId,
          conversationTitle,
          isFirstMessage,
          runtimeConfig,
          imagePaths,
        },
      );
      // Keep desired/applied revision bookkeeping correct on follow-up turns.
      // The send action has accepted the request at this point; runtime errors
      // are still represented by the normal stream error event.
      markConversationWorkspaceStarted(currentInstance.instanceId);
    } catch (err) {
      // 仅线程创建/绑定失败会走到这里; 输入与草稿保持原样以便重试。
      logger.error('Failed to create conversation thread', { error: String(err) });
      toast.error(tRef.current('agent.chat.sendFailed'));
    } finally {
      submittingRef.current = false;
    }
  }, [clearComposerAfterSlashCommand, runCodexSlashCommandFromDetail, runDshCommandFromDetail]);
  submitRef.current = submit;

  useEffect(() => {
    if (!threadId || !instance) return;
    const store = useAgentSessionStore.getState();
    const release = acquireThreadInterest(threadId);
    void store.loadMessages(instance.agentType, threadId);
    return release;
  }, [instance, threadId]);

  useEffect(() => {
    setShowScrollTopHint(false);
  }, [instanceId]);

  useLayoutEffect(() => {
    const dom = domRef.current;
    const body = bodyRef.current;
    const composerMount = composerMountRef.current;
    const loadingIndicator = loadingIndicatorRef.current;
    if (!dom || !body || !composerMount || !loadingIndicator) return;

    const restoredDraft = readDetailDraft(instanceId);
    draftRef.current = restoredDraft || null;
    const composerParts = createAgentComposerDom({
      variant: 'expanded',
      inputDraft: restoredDraft,
      t: (key) => tRef.current(key),
    });
    composerMount.append(composerParts.composer);
    const {
      composer,
      composerImages,
      composerActions,
      composerRoleIcon: composerRoleButton,
      input,
      codexSettingsPopover: settingsPopover,
      composerRolePopover: rolePopover,
      composerAddPopover: addPopover,
      sendButtonMount,
    } = composerParts;
    inputRef.current = input;

    const handleMessageLinkClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const link = target.closest<HTMLAnchorElement>('a[href]');
      if (!link) return;

      event.preventDefault();
      event.stopPropagation();
      const rawHref = link.getAttribute('href');
      void (async () => {
        const { normalizePlainLinkHref } = await import(
          '@features/editor/extensions/markdown-link'
        );
        const href = normalizePlainLinkHref(rawHref);
        if (!href) return;
        if (href.startsWith('flowix://')) {
          await openNoteByDeepLink(href);
          return;
        }
        if (/^https?:\/\//i.test(href)) {
          await openBrowserColumnWebpage(href);
          return;
        }
        const localPath = localFilePathFromAgentHref(rawHref);
        if (!localPath) {
          await openUrl(href);
          return;
        }

        const scopePath = agentFileScopePathForRuntime(
          localPath,
          instanceRef.current?.runtimeConfig,
        );
        if (scopePath) {
          await openBrowserColumnFileBrowser(scopePath, localPath);
          return;
        }

        if (isEditableTextFilePath(localPath)) {
          const parentPath = localPath.replace(/[\\/][^\\/]*$/, '') || localPath;
          await openBrowserColumnText(localPath, parentPath);
          return;
        }
        await openPath(localPath);
      })().catch((error) => {
        logger.error('Failed to open conversation link', { error });
      });
    };
    body.addEventListener('click', handleMessageLinkClick);

    destroyedRef.current = false;
    const externalSettings = new ExternalAgentSettingsController({
      popover: settingsPopover,
      getTypeKey: () => typeKeyRef.current,
      getInstanceId: () => instanceRef.current?.instanceId,
      getLanguage: () => languageRef.current,
      t: (key) => tRef.current(key),
      isDestroyed: () => destroyedRef.current,
      isRunning: () => isLoadingRef.current || isDshCommandRunningRef.current || isCodexCommandRunningRef.current || submittingRef.current,
    });
    externalSettingsRef.current = externalSettings;
    const composerModelButton = externalSettings.createComposerModelButton();
    if (composerModelButton) composerActions.append(composerModelButton);
    const composerModeButton = externalSettings.createComposerModeButton();
    if (composerModeButton) composerActions.append(composerModeButton);
    const composerPermissionButton = externalSettings.createComposerPermissionButton();
    if (composerPermissionButton) composerActions.append(composerPermissionButton);
    const composerWorkspaceButton = externalSettings.createComposerWorkspaceButton();
    if (composerWorkspaceButton) composerActions.append(composerWorkspaceButton);
    externalSettings.loadDefaultModel();
    const composerDraft = new ComposerDraftController({
      persistDelayMs: 0,
      persist: (draft) => {
        draftRef.current = draft;
        persistDetailDraft(instanceId, draft);
      },
    });
    const composerImagesController = new ComposerImageController({
      input,
      container: composerImages,
      initialImages: [],
      onChange: () => undefined,
      onStateChange: () => composerControllerRef.current?.setSendButtonState(),
      onError: (message) => toast.error(message),
      onLimitExceeded: (kind) => toast.warning(tRef.current(
        kind === 'size' ? 'editor.threadCard.imageSizeLimit' : 'editor.threadCard.imageCountLimit',
      )),
    });
    let messageController: AgentThreadCardMessagesController;
    const surface = new AgentConversationSurfaceController({
      dom,
      body,
      loadingIndicator,
      composer,
      input,
      inputDraft: restoredDraft,
      sendButtonMount,
      messageOptions: {
        bottomFollowThresholdPx: BOTTOM_FOLLOW_THRESHOLD_PX,
        topHistoryLoadThresholdPx: TOP_HISTORY_LOAD_THRESHOLD_PX,
        scrollDeltaEpsilonPx: SCROLL_DELTA_EPSILON_PX,
        isDestroyed: () => destroyedRef.current,
        isCollapsed: () => false,
        isFullscreen: () => true,
        getThreadId: () => threadIdRef.current,
        getRuntimeThreadId: () => renderThreadIdRef.current,
        getConversationMessageState: () => {
          const id = renderThreadIdRef.current;
          return id ? useAgentSessionStore.getState().getMessageState(id) : null;
        },
        loadMoreMessages: (id) => {
          void useAgentSessionStore.getState().loadMoreMessages(typeKeyRef.current, id);
        },
        getLanguage: () => languageRef.current,
        getTypeKey: () => typeKeyRef.current,
        getMessageCount: () => messagesRef.current.length,
        shouldLoadThreadMessages: () => false,
        renderThreadState: () => {
          messageController.render({
            messages: messagesRef.current,
            isLoading: isLoadingRef.current || isDshCommandRunningRef.current || isCodexCommandRunningRef.current,
            shouldRenderMessages: true,
            isInitialHistoryLoading: shouldShowInitialHistorySkeleton(
              renderThreadIdRef.current,
              messagesRef.current.length,
              renderThreadIdRef.current
                ? useAgentSessionStore.getState()
                    .threadProjections[renderThreadIdRef.current]?.pagination.initialStatus
                : undefined,
            ),
          });
        },
        renderResolvedSessionMessages: (resolvedMessages) => {
          const id = renderThreadIdRef.current;
          if (id) useAgentSessionStore.getState().mergeMessages(typeKeyRef.current, id, resolvedMessages);
        },
        applyResolvedSession: (localThreadId, sessionId, typeKey) => {
          useAgentSessionStore.getState().applySessionResolved({
            kind: 'session_resolved', agentType: typeKey, threadId: localThreadId,
            sessionId, runId: sessionId, timestamp: Date.now(),
          });
        },
        t: (key) => tRef.current(key),
        createThreadCacheSkeleton: () => createThreadCacheSkeleton(tRef.current('editor.threadCard.loadingThreadCache')),
        createExternalAgentEmptySettings: () => externalSettings.createEmptySettings(),
        onForkMessage: forkFromMessage,
      },
      composerOptions: {
        draft: composerDraft,
        inputDraftMaxChars: INPUT_DRAFT_MAX_CHARS,
        getCurrentInputDraft: () => draftRef.current ?? '',
        getUserHistoryMessages: () => getAgentThreadCardUserHistoryMessagesFromMessages(messagesRef.current),
        getSendLabel: (wantStop, isRunning) => isRunning
          ? tRef.current('editor.threadCard.running')
          : tRef.current(wantStop ? 'editor.threadCard.stop' : 'editor.threadCard.send'),
        getSendButtonWantsStop: () => {
          // `/goal` is the one native Codex command that exposes a real stop
          // action. It must win over the draft/steering condition below.
          if (isCodexCommandStoppableRef.current) return true;
          return isLoadingRef.current &&
            !isDshCommandRunningRef.current &&
            !isCodexCommandRunningRef.current &&
            !((typeKeyRef.current === 'codex' || typeKeyRef.current === 'deepseek-harness') &&
              !!composerControllerRef.current?.getPrompt().trim());
        },
        getSendButtonRunning: () =>
          isDshCommandRunningRef.current ||
          (isCodexCommandRunningRef.current && !isCodexCommandStoppableRef.current),
        getHasAttachments: () => composerImagesController.hasImages,
        getHasPendingAttachments: () => composerImagesController.hasPending,
        agentType: typeKeyRef.current,
        listDshSkills: async () => {
          if (typeKeyRef.current !== 'deepseek-harness') return [];
          const ensured = await ensureDshCommandConversation('/skill');
          return listDshSkills({
            threadId: ensured.threadId,
            runtimeConfig: ensured.runtimeConfig,
          });
        },
        listCodexSkills: async () => {
          if (typeKeyRef.current !== 'codex') return [];
          const ensured = await ensureCodexCommandConversation('/skill');
          const cwd = ensured.runtimeConfig.workspaceSnapshot?.cwd ?? ensured.runtimeConfig.cwd;
          return listCodexSkills(cwd ?? '');
        },
        onModelSelect: () => {
          clearComposerAfterSlashCommand();
          externalSettings.openComposerModelPicker();
        },
        onPermissionSelect: () => {
          clearComposerAfterSlashCommand();
          externalSettings.openComposerPermissionPicker();
        },
        onDirectCommand: (command) => {
          clearComposerAfterSlashCommand();
          if (typeKeyRef.current === 'codex') {
            void runCodexSlashCommandFromDetail(`/${command.name}`);
            return;
          }
          void runDshCommandFromDetail(`/${command.name}`);
        },
        submit: () => submitRef.current(),
        stop: () => {
          const id = renderThreadIdRef.current;
          if (id) void useAgentSessionStore.getState().stopThreadRun(id);
        },
      },
    });
    messageController = surface.messages;
    const composerController = surface.composer;
    const rolePicker = new AgentRolePickerController({
      trigger: composerRoleButton,
      popover: rolePopover,
      // 必须把 params 透传给 tRef.current ── formatTimeAgo 走的是
      // t('memo.time.minutesAgo', { m }) 这种带参调用, 老 wrapper
      // (key) => tRef.current(key) 会丢掉 params, 让 translate 拿到
      // undefined, 文案就只剩 "{m} 分钟前" 字面量, 数字永远不替换。
      t: (key, params) => tRef.current(key, params),
      isDestroyed: () => destroyedRef.current,
      getCurrentMemoId: () => instanceRef.current?.role?.memoId?.trim() || null,
      getCurrentName: () => instanceRef.current?.role?.name?.trim() || null,
      getMessageCount: () => messagesRef.current.length,
      updateRole: (role) => {
        const target = instanceRef.current;
        if (target) useAgentSessionStore.getState().upsertInstance(target.instanceId, { role });
      },
      consumeOutsidePointer: () => undefined,
      injectMemoReference: (ref) => {
        composerController.insertMemoReference(ref);
      },
      triggerManagedExternally: true,
    });
    const addMenu = new ComposerAddMenuController({
      trigger: composerRoleButton,
      popover: addPopover,
      rolePopover: rolePopover,
      rolePicker,
      images: composerImagesController,
      t: (key) => tRef.current(key),
      isDestroyed: () => destroyedRef.current,
      getAgentType: () => typeKeyRef.current,
      openCodexSettings: () => {
        const runtimeConfig = instanceRef.current?.runtimeConfig;
        const notebookPath = runtimeConfig?.workspaceSnapshot?.cwd
          ?? runtimeConfig?.cwd
          ?? useMemoStore.getState().selectedNotebook?.path;
        if (notebookPath) {
          codexSettingsDialogRef.current ??= new CodexSettingsDialogController();
          codexSettingsDialogRef.current.open(notebookPath);
        }
      },
    });
    rolePicker.refreshIcon();
    messagesControllerRef.current = messageController;
    composerControllerRef.current = composerController;
    surfaceRef.current = surface;
    composerImagesControllerRef.current = composerImagesController;
    rolePickerRef.current = rolePicker;
    addMenuRef.current = addMenu;
    composerController.updateMultiLineState();
    // Paint the selected thread's initial state in the same layout pass. The
    // history request starts in a passive effect, so waiting for the normal
    // subscription effect would leave one blank frame between item selection
    // and the skeleton.
    messageController.render({
      messages: messagesRef.current,
      isLoading: isLoadingRef.current || isDshCommandRunningRef.current || isCodexCommandRunningRef.current,
      shouldRenderMessages: true,
      isInitialHistoryLoading: shouldShowInitialHistorySkeleton(
        renderThreadIdRef.current,
        messagesRef.current.length,
        renderThreadIdRef.current
          ? useAgentSessionStore.getState()
              .threadProjections[renderThreadIdRef.current]?.pagination.initialStatus
          : undefined,
      ),
    });

    return () => {
      destroyedRef.current = true;
      body.removeEventListener('click', handleMessageLinkClick);
      composerController.flushPendingDraft();
      surface.dispose();
      composerImagesController.dispose();
      rolePicker.dispose();
      addMenu.dispose();
      externalSettings.dispose();
      codexSettingsDialogRef.current?.close();
      codexSettingsDialogRef.current = null;
      externalSettingsRef.current = null;
      disposeAgentComposerDom(composerParts);
      inputRef.current = null;
      messagesControllerRef.current = null;
      composerControllerRef.current = null;
      surfaceRef.current = null;
      composerImagesControllerRef.current = null;
      rolePickerRef.current = null;
      addMenuRef.current = null;
    };
  }, []);

  useEffect(() => {
    messagesControllerRef.current?.render({
      messages,
      isLoading: isLoading || isCommandRunning,
      shouldRenderMessages: true,
      isInitialHistoryLoading,
    });
    composerControllerRef.current?.setSendButtonState();
    rolePickerRef.current?.refreshIcon();
  }, [isInitialHistoryLoading, isLoading, isCommandRunning, messages]);

  useEffect(() => {
    externalSettingsRef.current?.refreshEmptySettings();
  }, [instance?.threadId, isLoading, isCommandRunning]);

  if (!instance) {
    return (
      <div className="relative flex h-full w-full items-center justify-center bg-[var(--editor-block-bg,var(--document-bg))]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-no-repeat bg-bottom bg-[length:auto_800px] opacity-[0.32]"
          style={{ backgroundImage: `url(${backgroundImage})` }}
        />
        <span className="relative text-center text-sm text-[var(--muted-foreground)]">
          {t('status.agent.conversationNotFound')}
        </span>
      </div>
    );
  }

  return (
    <section className="agent-conversation-detail markdown-editor flex h-full min-h-0 flex-col">
      <div ref={domRef} className="agent-thread-card agent-conversation-detail__card flex min-h-0 flex-1 flex-col">
        <div className="agent-conversation-detail__body-shell">
          <div
            ref={bodyRef}
            className="agent-thread-card__body"
            data-no-context-menu-scroll
            onScroll={(event) => {
              const target = event.currentTarget;
              setShowScrollTopHint(target.scrollTop > SCROLL_DELTA_EPSILON_PX);
              messagesControllerRef.current?.handleScroll();
            }}
            onWheel={(event) => {
              messagesControllerRef.current?.handleUserScrollIntent(event.deltaY);
            }}
          >
            <div ref={loadingIndicatorRef} className="agent-thread-card__loading-indicator" role="status" aria-live="polite">
              <span className="agent-thread-card__loading-cells" aria-hidden="true">
                {[0, 1, 2, 3].map((step) => (
                  <span key={step} className="agent-thread-card__loading-cell" style={{ '--cell-step': String(step) } as CSSProperties} />
                ))}
              </span>
              <span className="agent-thread-card__loading-text" />
            </div>
          </div>
          <div
            aria-hidden="true"
            className={[
              'pointer-events-none absolute inset-x-0 top-0 z-[3] h-2',
              'bg-gradient-to-b from-[color-mix(in_oklch,var(--foreground)_1%,transparent)] to-transparent',
              'transition-opacity duration-200',
              showScrollTopHint ? 'opacity-100' : 'opacity-0',
            ].join(' ')}
          />
        </div>
        <div className="agent-conversation-detail__composer-stack">
          <AgentBackgroundTerminals
            threadId={threadId}
            agentType={instance.agentType === 'codex' ? 'codex' : 'deepseek-harness'}
            enabled={instance.agentType === 'codex' || instance.agentType === 'deepseek-harness'}
            queuedMessages={pendingSteeringMessages.map((message) => message.content)}
          />
          <div ref={composerMountRef} />
        </div>
      </div>
    </section>
  );
}
