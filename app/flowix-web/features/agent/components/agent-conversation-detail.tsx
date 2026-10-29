'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type UIEventHandler, type WheelEventHandler } from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import { DEFAULT_AGENT_TYPE_KEY } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { agent } from '@platform/tauri/client/agent';
import { useAgentConversationSurface } from './use-agent-conversation-surface';
import { isInitialConversationHistoryLoading } from './agent-conversation-history-loading';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { createAndOpenAgentConversation } from '@features/agent/use-cases/new-conversation';
import { canActOnQueuedMessage } from '@features/agent/store/follow-up-queue-slice';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { useNoteStore } from '@features/memo/store/note-store';
import { acquireThreadInterest } from '@features/agent/store/thread-interest';
import { isAgentThreadWorking, type ThreadState } from '@features/agent/store/thread-runtime-state';
import {
  AgentThreadCardMessagesController,
  createThreadCacheSkeleton,
} from '@features/agent/thread-card/messages';
import { loadAgentThreadCardCache } from '@features/agent/thread-card/agent-thread-card-cache';
import { isMissingAgentSessionError } from '@features/agent/services/history-error';
import {
  ComposerController,
  ComposerSubmissionController,
  getComposerRuntimeState,
  ComposerDraftController,
  ComposerAttachmentController,
  ComposerAttachmentDocument,
  ComposerAddMenuController,
  getCurrentNotebookComposerFolders,
  createAgentComposerDom,
  disposeAgentComposerDom,
  getAgentThreadCardUserHistoryMessagesFromMessages,
} from '@features/agent/thread-card/composer';
import { NotePickerController } from '@features/agent/thread-card/note/note-picker-controller';
import { ExternalAgentSettingsController } from '@features/agent/thread-card/settings/external-agent-settings-controller';
import { NotebookAgentSettingsDialogController } from '@features/agent/thread-card/settings/notebook-agent-settings-dialog';
import { AgentConversationSurfaceController } from '@features/agent/thread-card/surface/agent-conversation-surface-controller';
import { createExternalAgentRuntimeHandle } from '@features/agent/services/external-agent-runtime-service';
import { ensureAgentConversationDetailThread, needsAgentConversationInitialization } from '@features/agent/components/agent-conversation-detail-submit';
import { ensureConversationWorkspaceSnapshot, markConversationWorkspaceStarted } from '@features/agent/runtime/workspace-snapshot';
import { AgentBackgroundTerminals } from '@features/agent/components/agent-background-terminals';
import { CodexApprovalQueue } from '@features/agent/components/codex-approval-queue';
import { buildInitialInstanceRuntimeConfig } from '@features/agent/store/initial-runtime-config';
import { defaultThreadTitle } from '@features/agent/store/thread-titles';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import {
  agentFileScopePathForRuntime,
  handleAgentLinkClick,
} from '@features/agent/thread-card/link-navigation';
import {
  listDshSkills,
} from '@features/agent/services/dsh-command-service';
import {
  listCodexSkills,
} from '@features/agent/services/codex-slash-command-service';
import { listPiSkills } from '@features/agent/services/pi-slash-command-service';
import { isCodexGoalCommand } from '@features/agent/thread-card/agent-thread-card-selectors';
import { acceptComposerSubmission, type ComposerConversationBinding } from '@features/agent/services/composer-submission-service';
import { WorkspaceEmptyState } from '@shared/ui/workspace-empty-state';
import { Button } from '@shared/ui/button';
import { createRunId } from '@features/agent/events/agent-event-mapper';
import { completedRunUserMessageId } from '@features/agent/events/message-identity';
import { createAgentMessageAttachments, prepareUserMessage } from '@features/agent/store/user-message';
import { isAgentThreadCardImageAttachment } from '@features/agent/thread-card/composer/composer-attachment-types';
import {
  getAgentMessageTypographyCssVars,
  useAgentMessageFontStore,
} from '@features/agent/store/agent-message-font-store';
import { ensureDownloadedFontRegistered } from '@features/preferences/public/font-api';
import { getTypographyFontId } from '@/lib/typography-font-mode';

const BOTTOM_FOLLOW_THRESHOLD_PX = 96;
const TOP_HISTORY_LOAD_THRESHOLD_PX = 48;
const SCROLL_DELTA_EPSILON_PX = 0.5;
const INPUT_DRAFT_MAX_CHARS = 500;
const EMPTY_MESSAGES: ThreadState['messages'] = [];
const EMPTY_PENDING_CODEX_MESSAGES: readonly [] = [];

const DETAIL_DRAFT_KEY_PREFIX = 'flowix:agent-conversation-draft:';
const logger = createLogger('agent-conversation-detail');

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
  reportPresentation,
}: {
  instanceId: string;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}) {
  const { t } = useI18n();
  const { instance, status, retry } = useAgentConversationSurface(instanceId, reportPresentation);

  if (instance) {
    return <AgentConversationDetailContent key={instanceId} instanceId={instanceId} instance={instance} />;
  }

  if (reportPresentation) return null;
  return (
    <WorkspaceEmptyState
      tone="agent"
      message={status === 'loading' ? t('status.agent.loadingConversations') : (
        <span className="flex flex-col items-center gap-3">
          <span>{t(status === 'error' ? 'status.agent.loadConversationsFailed' : 'status.agent.conversationNotFound')}</span>
          <Button variant="outline" size="sm" className="rounded-lg" onClick={retry}>
            {t('error.retry')}
          </Button>
        </span>
      )}
    />
  );
}

/** Mount the controller-owned DOM only after the instance identity is restored. */
function AgentConversationDetailContent({
  instanceId,
  instance,
}: {
  instanceId: string;
  instance: AgentConversationInstance;
}) {
  const { language, t } = useI18n();
  const selectedNotebookId = useNoteStore((state) => state.selectedNotebook?.id ?? null);
  const messageFontMode = useAgentMessageFontStore((state) => state.fontMode);
  const messageSizeMode = useAgentMessageFontStore((state) => state.sizeMode);
  useEffect(() => {
    if (messageFontMode === 'standard') return;
    const fontId = getTypographyFontId(messageFontMode);
    void ensureDownloadedFontRegistered(fontId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('preferences.format.fontDownloadFailed', { message }));
    });
  }, [messageFontMode, t]);
  const threadId = instance.threadId;
  const renderThreadId = threadId;
  const { messages, runs, initialHistoryStatus, initialHistoryError } = useAgentSessionStore(useShallow((state) => {
    const projection = renderThreadId ? state.threadProjections[renderThreadId] : undefined;
    return {
      messages: projection?.messages ?? EMPTY_MESSAGES,
      runs: projection?.runs,
      initialHistoryStatus: projection?.pagination.initialStatus ?? 'idle',
      initialHistoryError: projection?.pagination.initialError,
    };
  }));
  const isLoading = isAgentThreadWorking(runs ? { ...runs, messages } : undefined);
  const isStopping = runs?.activeRunId
    ? runs.runs[runs.activeRunId]?.phase === 'stopping'
    : false;
  const isDshCommandRunning = runs?.dshCommand?.status === 'pending';
  const isCodexCommandRunning = runs?.codexCommand?.status === 'pending';
  const isCodexCommandStoppable =
    isCodexCommandRunning && isCodexGoalCommand(runs?.codexCommand?.command);
  const isCommandRunning = isDshCommandRunning || isCodexCommandRunning;
  const latestCompletedRunId = useAgentSessionStore((state) => (
    threadId ? state.latestCompletedRunIds[threadId] ?? null : null
  ));
  const markThreadRead = useAgentSessionStore((state) => state.markThreadRead);
  const pendingSteeringMessages = useAgentSessionStore((state) =>
    threadId
      ? state.pendingSteeringMessages[threadId] ?? EMPTY_PENDING_CODEX_MESSAGES
      : EMPTY_PENDING_CODEX_MESSAGES,
  );
  const missingSession = isMissingAgentSessionError(initialHistoryError);
  const isInitialHistoryLoading = isInitialConversationHistoryLoading(
    threadId,
    messages.length,
    initialHistoryStatus,
  );
  const showHistoryError = initialHistoryStatus === 'error' && messages.length === 0;
  const showHistoryWarning = initialHistoryStatus === 'error' && messages.length > 0;
  const domRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerMountRef = useRef<HTMLDivElement>(null);
  const loadingIndicatorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const messagesControllerRef = useRef<AgentThreadCardMessagesController | null>(null);
  const composerControllerRef = useRef<ComposerController | null>(null);
  const composerAttachmentsControllerRef = useRef<ComposerAttachmentController | null>(null);
  const externalSettingsRef = useRef<ExternalAgentSettingsController | null>(null);
  const addMenuRef = useRef<ComposerAddMenuController | null>(null);
  const notebookAgentSettingsDialogRef = useRef<NotebookAgentSettingsDialogController | null>(null);
  const surfaceRef = useRef<AgentConversationSurfaceController | null>(null);
  const draftRef = useRef<string | null>(null);
  const destroyedRef = useRef(false);
  const renderThreadIdRef = useRef<string | null>(renderThreadId);
  const typeKeyRef = useRef<AgentTypeKey>(instance?.agentType ?? DEFAULT_AGENT_TYPE_KEY);
  const messagesRef = useRef(messages);
  const isLoadingRef = useRef(isLoading);
  const isDshCommandRunningRef = useRef(isDshCommandRunning);
  const isCodexCommandRunningRef = useRef(isCodexCommandRunning);
  const instanceRef = useRef(instance);
  const threadIdRef = useRef(threadId);
  const runtimeHandleRef = useRef<string | null>(null);
  const submissionRef = useRef(new ComposerSubmissionController());
  const pendingFirstMessageRef = useRef<{ runId: string; messages: ThreadState['messages'] } | null>(null);
  const languageRef = useRef(language);
  const tRef = useRef(t);
  const submitRef = useRef<() => void>(() => undefined);
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);

  const forkFromMessage = useCallback(async (message: ThreadState['messages'][number]) => {
    const currentInstance = instanceRef.current;
    const sourceThreadId = threadIdRef.current;
    const agentType = currentInstance?.agentType;
    if (!currentInstance || !sourceThreadId || (agentType !== 'codex' && agentType !== 'dsh' && agentType !== 'pi')) return;
    if (agentType === 'codex' && !message.codexTurnId) return;
    if (agentType === 'dsh' && message.sourceSequence === undefined) return;
    if (agentType === 'pi' && !message.messageId) return;

    if (destroyedRef.current) return;

    try {
      const result = agentType === 'codex'
        ? await agent.forkCodexThread(sourceThreadId, message.codexTurnId!)
        : agentType === 'dsh'
          ? await agent.forkDeepSeekHarnessThread(sourceThreadId, message.sourceSequence!)
          : await agent.forkPiThread(sourceThreadId, message.messageId!);
      const fork = useAgentSessionStore.getState().createInstance({
        agentType,
        title: `${currentInstance.title || defaultThreadTitle(agentType)} (fork)`,
        threadId: result.thread.threadId,
        runtimeConfig: {
          ...(currentInstance.runtimeConfig ?? buildInitialInstanceRuntimeConfig(agentType)),
          ...(agentType === 'pi' && 'cwd' in result ? { cwd: result.cwd } : {}),
        },
        source: { kind: 'dedicated', notebookId: currentInstance.source.notebookId ?? null },
      });
      await openWorkspaceSurface({ host: 'main-third', target: { kind: 'agent-conversation', instanceId: fork.instanceId } });
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
  instanceRef.current = instance;
  threadIdRef.current = threadId;
  languageRef.current = language;
  tRef.current = t;

  const renderCurrentMessages = useCallback(() => {
    const id = renderThreadIdRef.current ?? threadIdRef.current;
    const current = id ? useAgentSessionStore.getState().threadProjections[id] : undefined;
    const pending = pendingFirstMessageRef.current;
    const visibleMessages = current?.messages.length
      ? current.messages
      : pending?.messages ?? current?.messages ?? EMPTY_MESSAGES;
    messagesControllerRef.current?.render({
      messages: visibleMessages,
      isLoading: current ? (
        isAgentThreadWorking({ ...current.runs, messages: current.messages }) ||
        current.runs.dshCommand?.status === 'pending' ||
        current.runs.codexCommand?.status === 'pending'
      ) : false,
      shouldRenderMessages: true,
      isInitialHistoryLoading: isInitialConversationHistoryLoading(id, visibleMessages.length, current?.pagination.initialStatus),
    });
  }, []);

  const clearComposerAfterSettingsCommand = useCallback(() => {
    composerControllerRef.current?.clear();
    composerControllerRef.current?.clearDraft();
    persistDetailDraft(instanceId, null);
    composerControllerRef.current?.updateMultiLineState();
  }, [instanceId]);

  const ensureDshCommandConversation = useCallback(async (command: string) => {
    if (typeKeyRef.current !== 'dsh') {
      throw new Error('This slash command is only available for DSH');
    }
    const currentInstance = instanceRef.current;
    if (!currentInstance) throw new Error('Agent session instance was not found');
    const currentThreadId = threadIdRef.current;
    if (!currentThreadId || needsAgentConversationInitialization(currentInstance)) {
      if (!runtimeHandleRef.current) {
        runtimeHandleRef.current = createExternalAgentRuntimeHandle();
      }
      const ensured = await ensureAgentConversationDetailThread({
        instanceId: currentInstance.instanceId,
        typeKey: 'dsh',
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

  const composerRuntimeState = useCallback(() => {
    const id = threadIdRef.current;
    return getComposerRuntimeState(typeKeyRef.current,
      id ? useAgentSessionStore.getState().threadProjections[id] : undefined,
      submissionRef.current.isSubmitting, !destroyedRef.current && !!instanceRef.current);
  }, []);

  const submit = useCallback(async () => {
    const composer = composerControllerRef.current;
    const images = composerAttachmentsControllerRef.current;
    const currentInstance = instanceRef.current;
    if (!composer || !images || !currentInstance) return;
    const isDisposed = () => destroyedRef.current || composerControllerRef.current !== composer;
    await submissionRef.current.submit({
      composer, images, getRuntime: composerRuntimeState, isDisposed,
      bind: async (snapshot, kind): Promise<ComposerConversationBinding> => {
        const targetThreadId = threadIdRef.current;
        if (targetThreadId && !needsAgentConversationInitialization(currentInstance)) return {
          instanceId: currentInstance.instanceId,
          threadId: targetThreadId,
          typeKey: currentInstance.agentType,
          title: currentInstance.title,
          runtimeConfig: ensureConversationWorkspaceSnapshot(currentInstance.instanceId),
          isFirstMessage: false,
        };
        if (kind === 'message') {
          const runId = createRunId(currentInstance.instanceId);
          const { userMessage } = prepareUserMessage({
            content: snapshot.prompt,
            agentType: currentInstance.agentType,
            isFirstMessage: true,
            attachments: createAgentMessageAttachments(
              snapshot.attachments.filter(isAgentThreadCardImageAttachment),
            ),
          });
          userMessage.id = completedRunUserMessageId(currentInstance.agentType, runId);
          userMessage.renderKey = userMessage.id;
          pendingFirstMessageRef.current = { runId, messages: [userMessage] };
          renderCurrentMessages();
        }
        runtimeHandleRef.current ??= createExternalAgentRuntimeHandle();
        const ensured = await ensureAgentConversationDetailThread({
          instanceId: currentInstance.instanceId,
          typeKey: currentInstance.agentType,
          prompt: snapshot.prompt,
          runtimeHandleId: runtimeHandleRef.current,
        });
        if (!isDisposed()) threadIdRef.current = ensured.threadId;
        return { ...ensured, instanceId: currentInstance.instanceId,
          typeKey: currentInstance.agentType, isFirstMessage: true,
          runId: pendingFirstMessageRef.current?.runId };
      },
      accept: acceptComposerSubmission,
      clearPersistedDraft: () => {
        draftRef.current = null;
        persistDetailDraft(currentInstance.instanceId, null);
      },
      onPhaseChange: () => {
        if (!submissionRef.current.isSubmitting) pendingFirstMessageRef.current = null;
        composer.setSendButtonState();
        renderCurrentMessages();
      },
      onError: (error) => {
        logger.error('Failed to submit Agent message', { error });
        toast.error(error instanceof Error ? error.message : tRef.current('agent.chat.sendFailed'));
      },
    });
    if (!isDisposed()) composer.focus();
  }, [composerRuntimeState, renderCurrentMessages]);
  submitRef.current = submit;

  useEffect(() => {
    if (!threadId) return;
    const store = useAgentSessionStore.getState();
    const release = acquireThreadInterest(threadId);
    void loadAgentThreadCardCache({ threadId, typeKey: instance.agentType }).catch((error) => {
      logger.warn('Failed to load conversation history', { threadId, error: String(error) });
    });
    if (instance.agentType === "codex") void store.hydrateCodexFollowUps(threadId);
    return release;
  }, [instance.agentType, threadId]);

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
    const handleScrollToLatest = (event: MouseEvent): void => {
      event.stopPropagation();
      messagesControllerRef.current?.scrollToBottomSmooth();
    };
    composerParts.scrollToLatestButton.addEventListener('click', handleScrollToLatest);
    composerMount.append(composerParts.composer);
    const {
      composer,
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
      handleAgentLinkClick(event, instanceRef.current?.runtimeConfig, (error, rawHref) => {
        logger.error('Failed to open conversation link', { error, rawHref });
        toast.error(error instanceof Error ? error.message : String(error));
      });
    };
    body.addEventListener('click', handleMessageLinkClick);

    destroyedRef.current = false;
    const externalSettings = new ExternalAgentSettingsController({
      popover: settingsPopover,
      getTypeKey: () => typeKeyRef.current,
      getInstanceId: () => instanceRef.current?.instanceId,
      getLanguage: () => languageRef.current,
      // 独立对话只有一个形态: 展开态空状态 (欢迎卡 / 技能 / 常用笔记)。
      getEmptyStatePresentation: () => "expanded",
      t: (key, params) => tRef.current(key, params),
      isDestroyed: () => destroyedRef.current,
      isRunning: () => isLoadingRef.current || isDshCommandRunningRef.current || isCodexCommandRunningRef.current || submissionRef.current.isSubmitting,
      // 常用笔记卡片 → 注入 composer 输入框。
      onSelectFeaturedNote: (ref) => {
        composerControllerRef.current?.insertMemoReference(ref);
      },
      onSelectEmptyPrompt: (prompt) => {
        composerControllerRef.current?.setHistoryValue(prompt, { persistDraft: true });
      },
      onSelectEmptySkill: (skill) => {
        composerControllerRef.current?.selectSkill(skill);
      },
      onOpenEmptySkills: () => {
        composerControllerRef.current?.openSlashMenu();
      },
      toast: (kind, message) => toast[kind](message),
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
    const composerAttachmentsController = new ComposerAttachmentController({
      input,
      initialAttachments: [],
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
        onAtBottomChange: (atBottom) => {
          composerParts.scrollToLatestButton.hidden = atBottom || messagesRef.current.length === 0;
        },
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
        getImageSpacePath: (filePath) => agentFileScopePathForRuntime(
          filePath,
          instanceRef.current?.runtimeConfig,
        ),
        getMessageCount: () => messagesRef.current.length,
        shouldLoadThreadMessages: () => false,
        renderThreadState: renderCurrentMessages,
        applyResolvedSession: (localThreadId, sessionId, typeKey) => {
          useAgentSessionStore.getState().applySessionResolved({
            kind: 'session_resolved', agentType: typeKey, threadId: localThreadId,
            sessionId, runId: sessionId, timestamp: Date.now(),
          });
        },
      t: (key) => tRef.current(key),
        createThreadCacheSkeleton: () => createThreadCacheSkeleton(tRef.current('editor.threadCard.loadingThreadCache')),
        createExternalAgentEmptySettings: () =>
          externalSettings.createEmptySettings(),
        onForkMessage: forkFromMessage,
      },
      composerOptions: {
        draft: composerDraft,
        inputDraftMaxChars: INPUT_DRAFT_MAX_CHARS,
        getCurrentInputDraft: () => draftRef.current ?? '',
        getUserHistoryMessages: () => getAgentThreadCardUserHistoryMessagesFromMessages(messagesRef.current),
        getSendLabel: (label) => tRef.current(`editor.threadCard.${label}`),
        getRuntimeState: composerRuntimeState,
        getHasAttachments: () => composerAttachmentsController.hasAttachments,
        getHasPendingAttachments: () => composerAttachmentsController.hasPending,
        agentType: typeKeyRef.current,
        getSkillsScopeId: () => {
          const current = instanceRef.current;
          const runtime = current?.runtimeConfig;
          return runtime?.notebookId
            ?? runtime?.workspaceSnapshot?.notebookId
            ?? current?.source.notebookId
            ?? runtime?.workspaceSnapshot?.notebookPath
            ?? runtime?.cwd;
        },
        listDshSkills: async () => {
          if (typeKeyRef.current !== 'dsh') return [];
          const ensured = await ensureDshCommandConversation('/skill');
          return listDshSkills({
            threadId: ensured.threadId,
            runtimeConfig: ensured.runtimeConfig,
          });
        },
        listCodexSkills: async () => {
          if (typeKeyRef.current !== 'codex') return [];
          const current = instanceRef.current;
          const runtime = current?.runtimeConfig;
          const notebookId = runtime?.notebookId
            ?? runtime?.workspaceSnapshot?.notebookId
            ?? current?.source.notebookId;
          const notebookPath = runtime?.workspaceSnapshot?.notebookPath
            || (notebookId
              ? useNoteStore.getState().notebooks.find((item) => item.id === notebookId)?.path
              : undefined)
            || useNoteStore.getState().selectedNotebook?.path;
          return listCodexSkills(notebookPath ?? '');
        },
        listPiSkills: async () => {
          if (typeKeyRef.current !== 'pi') return [];
          const currentInstance = instanceRef.current;
          if (!currentInstance) return [];
          const runtimeConfig = ensureConversationWorkspaceSnapshot(currentInstance.instanceId);
          const cwd = runtimeConfig.workspaceSnapshot?.notebookPath
            ?? runtimeConfig.workspaceSnapshot?.cwd
            ?? runtimeConfig.cwd;
          return listPiSkills(cwd ?? '');
        },
        listFolders: () => getCurrentNotebookComposerFolders(),
        folderGroupLabel: tRef.current("agent.files.referenceLocal"),
        noteGroupLabel: tRef.current("agent.files.projectNotes"),
        onModelSelect: () => {
          clearComposerAfterSettingsCommand();
          externalSettings.openComposerModelPicker();
        },
        onPermissionSelect: () => {
          clearComposerAfterSettingsCommand();
          externalSettings.openComposerPermissionPicker();
        },
        onDirectCommand: () => submitRef.current(),
        submit: () => submitRef.current(),
        stop: () => {
          const id = renderThreadIdRef.current;
          if (id) void useAgentSessionStore.getState().stopThreadRun(id);
        },
      },
    });
    messageController = surface.messages;
    const composerController = surface.composer;
    composerAttachmentsController.connectDocument(
      new ComposerAttachmentDocument(composerController.editorInstance),
    );
    const notePicker = new NotePickerController({
      trigger: composerRoleButton,
      popover: rolePopover,
      t: (key, params) => tRef.current(key, params),
      isDestroyed: () => destroyedRef.current,
      injectMemoReference: (ref) => {
        composerController.insertMemoReference(ref);
      },
      onSelect: () => addMenuRef.current?.close(),
    });
    const addMenu = new ComposerAddMenuController({
      trigger: composerRoleButton,
      popover: addPopover,
      notePopover: rolePopover,
      notePicker,
      attachments: composerAttachmentsController,
      t: (key) => tRef.current(key),
      isDestroyed: () => destroyedRef.current,
      openNotebookAgentSettings: () => {
        const runtimeConfig = instanceRef.current?.runtimeConfig;
        const snapshot = runtimeConfig?.workspaceSnapshot;
        const notebookId = runtimeConfig?.notebookId
          ?? snapshot?.notebookId
          ?? instanceRef.current?.source.notebookId
          ?? null;
        const snapshotNotebookPath = snapshot?.notebookPath?.trim();
        const notebookPath = snapshotNotebookPath
          || (notebookId
            ? useNoteStore.getState().notebooks.find((item) => item.id === notebookId)?.path
            : undefined)
          || useNoteStore.getState().selectedNotebook?.path;
        if (notebookPath) {
          notebookAgentSettingsDialogRef.current ??= new NotebookAgentSettingsDialogController();
          notebookAgentSettingsDialogRef.current.open(notebookPath);
        }
      },
    });
    messagesControllerRef.current = messageController;
    composerControllerRef.current = composerController;
    surfaceRef.current = surface;
    composerAttachmentsControllerRef.current = composerAttachmentsController;
    addMenuRef.current = addMenu;
    composerController.updateMultiLineState();
    // Paint the selected thread's initial state in the same layout pass. The
    // history request starts in a passive effect, so waiting for the normal
    // subscription effect would leave one blank frame between item selection
    // and the skeleton.
    renderCurrentMessages();

    return () => {
      destroyedRef.current = true;
      body.removeEventListener('click', handleMessageLinkClick);
      composerParts.scrollToLatestButton.removeEventListener('click', handleScrollToLatest);
      composerController.flushPendingDraft();
      surface.dispose();
      composerAttachmentsController.dispose();
      notePicker.dispose();
      addMenu.dispose();
      externalSettings.dispose();
      notebookAgentSettingsDialogRef.current?.close();
      notebookAgentSettingsDialogRef.current = null;
      externalSettingsRef.current = null;
      disposeAgentComposerDom(composerParts);
      inputRef.current = null;
      messagesControllerRef.current = null;
      composerControllerRef.current = null;
      surfaceRef.current = null;
      composerAttachmentsControllerRef.current = null;
      addMenuRef.current = null;
      pendingFirstMessageRef.current = null;
    };
  }, [instanceId, renderCurrentMessages]);

  useEffect(() => {
    renderCurrentMessages();
  }, [isInitialHistoryLoading, isLoading, isCommandRunning, messages, renderCurrentMessages]);

  useEffect(() => {
    composerControllerRef.current?.setSendButtonState();
  }, [isLoading, isStopping, isDshCommandRunning, isCodexCommandRunning, isCodexCommandStoppable]);

  useEffect(() => {
    if (!threadId || !latestCompletedRunId || isLoading || isCommandRunning) return;
    if (isInitialHistoryLoading || messages.length === 0) return;
    markThreadRead(threadId, latestCompletedRunId);
  }, [isCommandRunning, isInitialHistoryLoading, isLoading, latestCompletedRunId, markThreadRead, messages.length, threadId]);

  useEffect(() => {
    externalSettingsRef.current?.refreshEmptySettings();
  }, [instance?.threadId, isLoading, isCommandRunning]);

  const handleBodyScroll: UIEventHandler<HTMLDivElement> = (event) => {
    const target = event.currentTarget;
    setShowScrollTopHint(target.scrollTop > SCROLL_DELTA_EPSILON_PX);
    messagesControllerRef.current?.handleScroll();
  };
  const handleBodyWheel: WheelEventHandler<HTMLDivElement> = (event) => {
    messagesControllerRef.current?.handleUserScrollIntent(event.deltaY);
  };
  const loadingIndicator = (
    <div ref={loadingIndicatorRef} className="agent-thread-card__loading-indicator" role="status" aria-live="polite">
      <span className="agent-thread-card__loading-cells" aria-hidden="true">
        {[0, 1, 2, 3].map((step) => (
          <span key={step} className="agent-thread-card__loading-cell" style={{ '--cell-step': String(step) } as CSSProperties} />
        ))}
      </span>
      <span className="agent-thread-card__loading-text" />
    </div>
  );

  return (
    <section
      className="agent-conversation-detail agent-conversation-surface flex h-full min-h-0 flex-col"
      style={getAgentMessageTypographyCssVars(messageFontMode, messageSizeMode) as CSSProperties}
    >
      <div ref={domRef} className="agent-thread-card agent-conversation-detail__card flex min-h-0 flex-1 flex-col">
        <div className="agent-conversation-detail__body-shell" data-no-context-menu-scroll>
          {document.documentElement.dataset.platform === 'mac' ? (
            <OverlayScrollbar
              className="agent-conversation-detail__body-frame h-full"
              scrollerClassName="agent-thread-card__body h-full"
              observeContent
              scrollerRef={bodyRef}
              onScroll={handleBodyScroll}
              onWheel={handleBodyWheel}
            >
              {loadingIndicator}
            </OverlayScrollbar>
          ) : (
            <div
              ref={bodyRef}
              className="agent-thread-card__body"
              onScroll={handleBodyScroll}
              onWheel={handleBodyWheel}
            >
              {loadingIndicator}
            </div>
          )}
          <div
            aria-hidden="true"
            className={[
              'pointer-events-none absolute inset-x-0 top-0 z-[3] h-2',
              'bg-gradient-to-b from-[color-mix(in_oklch,var(--foreground)_1%,transparent)] to-transparent',
              'transition-opacity duration-200',
              showScrollTopHint ? 'opacity-100' : 'opacity-0',
            ].join(' ')}
          />
          {showHistoryError && (
            <div className="absolute inset-0 z-[4]">
              <WorkspaceEmptyState
                tone="agent"
                message={(
                  <span className="flex flex-col items-center gap-3">
                    <span>{missingSession ? t('status.agent.historySessionNotFound') : t('status.agent.loadHistoryFailed')}</span>
                    {missingSession ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-lg"
                        onClick={() => {
                          const notebookId = instance.source.notebookId ?? selectedNotebookId;
                          if (notebookId) createAndOpenAgentConversation(instance.agentType, notebookId);
                        }}
                        disabled={!instance.source.notebookId && !selectedNotebookId}
                      >
                        {t('status.agent.newConversation')}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-lg"
                        onClick={() => {
                          if (threadId) void useAgentSessionStore.getState().loadMessages(instance.agentType, threadId);
                        }}
                      >
                        {t('error.retry')}
                      </Button>
                    )}
                  </span>
                )}
              />
            </div>
          )}
          {showHistoryWarning && (
            <div className="absolute inset-x-3 top-3 z-[4] flex items-center justify-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)]/95 px-3 py-2 text-xs text-[var(--muted-foreground)] shadow-sm" role="alert">
              <span>{missingSession ? t('status.agent.historySessionNotFound') : t('status.agent.historyRefreshFailed')}</span>
              {missingSession ? (
                <Button
                  variant="outline"
                  size="xs"
                  className="rounded-lg"
                  onClick={() => {
                    const notebookId = instance.source.notebookId ?? selectedNotebookId;
                    if (notebookId) createAndOpenAgentConversation(instance.agentType, notebookId);
                  }}
                  disabled={!instance.source.notebookId && !selectedNotebookId}
                >
                  {t('status.agent.newConversation')}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  className="rounded-lg"
                  onClick={() => {
                    if (threadId) void useAgentSessionStore.getState().loadMessages(instance.agentType, threadId);
                  }}
                >
                  {t('error.retry')}
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="agent-conversation-detail__composer-stack">
          {instance.agentType === 'codex' && <CodexApprovalQueue threadId={threadId} />}
          <AgentBackgroundTerminals
            threadId={threadId}
            agentType={instance.agentType === 'codex' ? 'codex' : 'dsh'}
            enabled={instance.agentType === 'codex' || instance.agentType === 'dsh'}
            queuedMessages={pendingSteeringMessages.map((message) => ({
              ...message,
              actionsDisabled: !canActOnQueuedMessage(
                message,
                instance.agentType === 'codex' ? 'codex' : 'pi',
              ),
            }))}
            onPromoteFollowUp={instance.agentType === 'pi' || instance.agentType === 'codex' ? (messageId) => {
              if (!threadId) return;
              void useAgentSessionStore.getState().promoteFollowUpToSteer(threadId, messageId)
                .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
            } : undefined}
            onDeleteQueuedMessage={instance.agentType === 'pi' || instance.agentType === 'codex' ? (messageId) => {
              if (!threadId) return;
              void useAgentSessionStore.getState().deleteQueuedFollowUp(threadId, messageId)
                .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
            } : undefined}
          />
          <div ref={composerMountRef} />
        </div>
      </div>
    </section>
  );
}
