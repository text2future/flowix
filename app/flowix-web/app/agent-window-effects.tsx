'use client';

import { lazy, Suspense, useEffect, useState } from 'react';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { SKILL_MARKET_UI_REQUEST_EVENT, type SkillMarketUiRequest } from '@shared/lib/skill-market-ui-request';
import { createLogger } from '@/lib/logger';
import { fireAndForget } from '@/lib/fire-and-forget';
const logger = createLogger('agent-catalog');
// Import the data modules directly. The `note-link` / `note-mention` /
// `tag-mention` barrels also re-export their TipTap Node views, which dragged
// ProseMirror into the desktop startup graph for two cache helpers.
import { invalidateNotebookCache, prewarmNotebookCache } from '@features/editor/extensions/note-link/memo-resolver';
import { invalidateMentionNotes } from '@features/editor/extensions/note-mention/note-mention-data';
import { invalidateMentionTags } from '@features/editor/extensions/tag-mention/tag-mention-data';
import { cloud, listenToAgentWorkspaceChanges, listenToCloudStateChanges, type CloudState } from '@platform/tauri/client';
import { acquireMemoEventBridge } from '@/lib/memo-dispatcher';
import { runStartupStage3Task, waitForStartupStage3 } from '@/lib/startup-stage3';
import { waitForWorkspaceRestoration } from './main-window-startup';

/**
 * Agent infrastructure shared by every content-capable Webview.
 *
 * Tauri content Webviews own their live Agent projection and backend hydration.
 * The browser column lives in the main Webview and therefore reuses this
 * infrastructure; preferences intentionally does not mount this component.
 */
const AgentEventSubscription = lazy(() =>
  import('@features/agent/public/agent-events').then((module) => ({
    default: module.AgentEventSubscription,
  })),
);

export function AgentWindowEffects() {
  const [eventsMounted, setEventsMounted] = useState(false);

  useEffect(() => {
    const openSkillMarketUi = (event: Event) => {
      const request = (event as CustomEvent<SkillMarketUiRequest>).detail;
      if (!request || (request.view !== 'skills' && request.view !== 'templates')) return;
      void import('@features/surface/public/open-skill-market-ui')
        .then((module) => module.openSkillMarketUi(request.view, request.index))
        .catch((error: unknown) => logger.warn('failed to open Skill Market UI', error));
    };
    window.addEventListener(SKILL_MARKET_UI_REQUEST_EVENT, openSkillMarketUi);
    return () => window.removeEventListener(SKILL_MARKET_UI_REQUEST_EVENT, openSkillMarketUi);
  }, []);

  // 实时订阅的依赖闭包是 agent-session-store 那条链（约 220 文件 / 3.3 万行），
  // 而首屏不消费它的任何投影：工作台首帧之前用户无法发起对话。因此把订阅推到
  // stage3（workbench 首帧之后）再挂载，让这份数据图留在按需 chunk 里。
  //
  // 用 waitForStartupStage3 而不是 runStartupStage3Task：setState 的副作用必须
  // 跟着本次挂载走，任务表是按 WebView 缓存的，重挂载后不会再回调。
  // 迟到不丢状态——useAgentEvents 挂载时会 reconcile 活跃 run 并补拉历史。
  useEffect(() => {
    let active = true;
    void waitForStartupStage3().then(() => {
      if (active) setEventsMounted(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => acquireMemoEventBridge(), []);
  const refreshAgentRuntime = useAgentRuntimeStore((state) => state.refresh);
  useEffect(() => {
    void runStartupStage3Task('agent-runtime-status-refresh', () => {
      // The native status command owns the CLI-discovery dependency for every
      // consumer, including refreshes initiated by feature-specific views.
      return refreshAgentRuntime({ force: true });
    });
  }, [refreshAgentRuntime]);

  useEffect(() => {
    let active = true;
    // Pi 云模型目录的同步要经过 pi-cloud-model-service → agent-catalog-service →
    // agent-data-store / codex-slash-command-service，后者又引 agent-session-store
    // （约 456 KB raw / 138 KB gzip）。它只影响"模型选择器里有哪些云模型"，
    // 首帧用不到，所以整条链走 stage3 之后的动态 import。
    const receiveCloudState = (state: CloudState) => {
      if (!active) return;
      void import('@features/agent/services/pi-cloud-model-service')
        .then((module) => module.syncPiCloudModelCatalog(state))
        .catch((error) => {
          logger.warn('failed to load Flowix Cloud Pi models after sign-in', error);
        });
    };
    const refreshSnapshot = () => {
      void cloud.getState().then(receiveCloudState).catch((error) => {
        logger.warn('failed to read Flowix Cloud session state', error);
      });
    };
    // 首帧的这次快照推到 stage3，否则上面的动态 import 会立刻执行，
    // 等于把整条目录链又拉回启动路径。
    //
    // 用 waitForStartupStage3 而不是 runStartupStage3Task：后者按 taskId 缓存，
    // 重挂载不会再跑，而"本次挂载是否还有效"必须跟着 effect 的 active 标志走。
    void waitForStartupStage3().then(() => {
      if (active) refreshSnapshot();
    });
    // 首次注册时 listenerReady 的语义与 stage3 的那次快照重复，交给 stage3 统一
    // 触发（否则动态 import 立刻执行，拆分没有意义）；之后的重连仍要立即刷新。
    let initialReadyHandled = false;
    const unlisten = listenToCloudStateChanges(receiveCloudState, {
      onListenerReady: () => {
        if (!initialReadyHandled) {
          initialReadyHandled = true;
          return;
        }
        refreshSnapshot();
      },
    });
    return () => {
      active = false;
      unlisten();
    };
  }, []);

  useEffect(() => {
    void runStartupStage3Task('agent-note-link-cache-prewarm', prewarmNotebookCache);
  }, []);

  useEffect(() => {
    return listenToAgentWorkspaceChanges(() => {
      invalidateNotebookCache();
      invalidateMentionNotes();
      invalidateMentionTags();
      fireAndForget(prewarmNotebookCache(), 'agent-window:prewarm-notebook-cache');
    });
  }, []);

  return eventsMounted ? (
    <Suspense fallback={null}>
      <AgentEventSubscription waitForWorkspaceRestore={waitForWorkspaceRestoration} />
    </Suspense>
  ) : null;
}
