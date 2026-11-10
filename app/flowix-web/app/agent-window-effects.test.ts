import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudState } from '@platform/tauri/client';

const mocks = vi.hoisted(() => ({
  waitForStartupReady: vi.fn(async (): Promise<void> => undefined),
  waitForWorkspaceRestoration: vi.fn(async (): Promise<void> => undefined),
  useAgentEvents: vi.fn(),
  refreshRuntime: vi.fn(async () => undefined),
  refreshCloudPiModelProviderAtStartup: vi.fn(async () => true),
  refreshCloudPiModelProvider: vi.fn(async () => false),
  piModelAvailability: vi.fn(async () => true),
  refreshAgentModelCatalog: vi.fn(async () => ({ items: [] })),
  loadWorkspace: vi.fn(async (): Promise<void> => undefined),
  initializePiMode: vi.fn(async () => undefined),
  initializeLegacySessionSettings: vi.fn(async () => undefined),
  listenWorkspace: vi.fn(),
  unlistenWorkspace: vi.fn(),
  getCloudState: vi.fn(async (): Promise<CloudState> => ({
    revision: 0,
    authenticated: false,
    authStatus: 'signed_out' as const,
  })),
  listenCloudState: vi.fn<(handler: (state: CloudState) => void) => () => void>(),
  cloudStateHandler: null as ((state: CloudState) => void) | null,
  unlistenCloudState: vi.fn(),
  setPiCloudAccount: vi.fn<(accountId: string | null, revision?: number) => void>(),
  piCloudAccountId: null as string | null,
  piCloudRevision: -1,
  piCloudCatalogEpoch: 0,
  invalidateNotebookCache: vi.fn(),
  prewarmNotebookCache: vi.fn(async () => undefined),
  invalidateMentionNotes: vi.fn(),
  invalidateMentionTags: vi.fn(),
  acquireMemoEventBridge: vi.fn(),
  releaseMemoEventBridge: vi.fn(),
}));

vi.mock('./main-window-startup', () => ({ waitForWorkspaceRestoration: mocks.waitForWorkspaceRestoration }));
vi.mock('@features/agent/services/agent-catalog-service', () => ({
  prefetchAvailableAgentModels: vi.fn(),
  prefetchNotebookSkills: vi.fn(),
  refreshAgentModelCatalog: mocks.refreshAgentModelCatalog,
  loadAgentModelCatalog: vi.fn(async () => ({ items: [] })),
}));
vi.mock('@features/memo/store/note-store', () => ({ useNoteStore: (selector: (state: { selectedNotebook: null }) => unknown) => selector({ selectedNotebook: null }) }));
vi.mock('@features/agent/hooks/use-agent-events', () => ({
  useAgentEvents: mocks.useAgentEvents,
}));
// 运行中投影的发布器同样读 agent-session-store（连带 platform client）。
// 本文件只验证 AgentWindowEffects 的生命周期编排，不验证投影计算，因此桩掉。
vi.mock('@features/agent/store/running-agent-selector', () => ({
  useRunningAgentTypeIndexPublisher: vi.fn(),
}));
vi.mock('@features/agent/store/agent-runtime-store', () => ({
  useAgentRuntimeStore: (selector: (state: { refresh: typeof mocks.refreshRuntime }) => unknown) => (
    selector({ refresh: mocks.refreshRuntime })
  ),
}));
vi.mock('@features/agent/store/agent-data-store', () => ({
  ensureAgentPreferencesReady: async () => {
    await Promise.all([mocks.initializePiMode(), mocks.initializeLegacySessionSettings()]);
  },
  useAgentDataStore: Object.assign(
    (selector: (state: { initializePiMode: typeof mocks.initializePiMode; initializeLegacySessionSettings: typeof mocks.initializeLegacySessionSettings }) => unknown) => (
      selector({ initializePiMode: mocks.initializePiMode, initializeLegacySessionSettings: mocks.initializeLegacySessionSettings })
    ),
    {
      getState: () => ({
        piCloudAccountId: mocks.piCloudAccountId,
        piCloudRevision: mocks.piCloudRevision,
        piCloudCatalogEpoch: mocks.piCloudCatalogEpoch,
        agents: { pi: { catalog: { models: { items: [] } } } },
        setPiCloudAccount: mocks.setPiCloudAccount,
        setPiCloudModelLoadState: vi.fn(),
      }),
    },
  ),
}));
vi.mock('@features/agent/store/agent-workspace-store', () => ({
  useAgentWorkspaceStore: (selector: (state: { workspaceActions: { loadInitial: typeof mocks.loadWorkspace } }) => unknown) => (
    selector({ workspaceActions: { loadInitial: mocks.loadWorkspace } })
  ),
}));
vi.mock('@features/editor/extensions/note-link/memo-resolver', () => ({
  invalidateNotebookCache: mocks.invalidateNotebookCache,
  prewarmNotebookCache: mocks.prewarmNotebookCache,
}));
vi.mock('@features/editor/public/mention-data-api', () => ({
  invalidateMentionNotes: mocks.invalidateMentionNotes,
  invalidateMentionTags: mocks.invalidateMentionTags,
}));
vi.mock('@platform/tauri/client', () => ({
  boot: { waitForStartupReady: mocks.waitForStartupReady },
  cloud: {
    getState: mocks.getCloudState,
    refreshPiModelProviderAtStartup: mocks.refreshCloudPiModelProviderAtStartup,
    refreshPiModelProvider: mocks.refreshCloudPiModelProvider,
    piModelAvailability: mocks.piModelAvailability,
  },
  listenToAgentWorkspaceChanges: mocks.listenWorkspace,
  listenToCloudStateChanges: mocks.listenCloudState,
}));
vi.mock('@/lib/memo-dispatcher', () => ({
  acquireMemoEventBridge: () => {
    mocks.acquireMemoEventBridge();
    return mocks.releaseMemoEventBridge;
  },
}));

import { AgentWindowEffects } from './agent-window-effects';
import { useAgentWorkspaceWindowLifecycle } from './use-agent-workspace-window-lifecycle';
import { admitStartupStage3 } from '@/lib/startup-stage3';

function PreferencesWorkspaceLifecycle() {
  useAgentWorkspaceWindowLifecycle();
  return null;
}

describe('AgentWindowEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listenWorkspace.mockReturnValue(mocks.unlistenWorkspace);
    mocks.piCloudAccountId = null;
    mocks.piCloudRevision = -1;
    mocks.piCloudCatalogEpoch = 0;
    mocks.setPiCloudAccount.mockImplementation((accountId, revision) => {
      if (revision !== undefined && revision < mocks.piCloudRevision) return;
      if (mocks.piCloudAccountId !== accountId) mocks.piCloudCatalogEpoch += 1;
      mocks.piCloudAccountId = accountId;
      mocks.piCloudRevision = revision ?? mocks.piCloudRevision;
    });
    mocks.getCloudState.mockResolvedValue({
      revision: 0,
      authenticated: false,
      authStatus: 'signed_out',
    });
    mocks.listenCloudState.mockImplementation((handler) => {
      mocks.cloudStateHandler = handler;
      return mocks.unlistenCloudState;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('loads preferences window Agent data without mounting the Agent runtime', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(createElement(PreferencesWorkspaceLifecycle)));

    expect(mocks.loadWorkspace).toHaveBeenCalledOnce();
    expect(mocks.initializePiMode).toHaveBeenCalledOnce();
    expect(mocks.initializeLegacySessionSettings).toHaveBeenCalledOnce();
    expect(mocks.listenWorkspace).toHaveBeenCalledOnce();
    expect(mocks.refreshRuntime).not.toHaveBeenCalled();
    expect(mocks.useAgentEvents).not.toHaveBeenCalled();
    expect(mocks.prewarmNotebookCache).not.toHaveBeenCalled();

    await act(async () => mocks.listenWorkspace.mock.calls[0][0]());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(2);

    const { onListenerReady } = mocks.listenWorkspace.mock.calls[0][1];
    await act(async () => onListenerReady());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(3);
    // Reconcile again if the native listener reconnects after a failure.
    await act(async () => onListenerReady());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(4);

    await act(async () => root.unmount());
    expect(mocks.unlistenWorkspace).toHaveBeenCalledOnce();
  });

  it('waits for native startup before reading workspace data', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    let ready!: () => void;
    mocks.waitForStartupReady.mockImplementationOnce(() => new Promise<void>((resolve) => { ready = resolve; }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(PreferencesWorkspaceLifecycle)));
      expect(mocks.loadWorkspace).not.toHaveBeenCalled();
      expect(mocks.initializePiMode).not.toHaveBeenCalled();
      expect(mocks.listenWorkspace).not.toHaveBeenCalled();
      await act(async () => ready());
      expect(mocks.loadWorkspace).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('does not read workspace data when native initialization fails', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    mocks.waitForStartupReady.mockRejectedValueOnce(new Error('migration failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(createElement(PreferencesWorkspaceLifecycle)));
      expect(mocks.loadWorkspace).not.toHaveBeenCalled();
      expect(mocks.initializePiMode).not.toHaveBeenCalled();
      expect(mocks.listenWorkspace).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      warn.mockRestore();
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('owns the shared Agent lifecycle for a content-capable Webview', async () => {
    function MainWorkspaceSync({ revision }: { revision: string }) {
      useAgentWorkspaceWindowLifecycle({ deferUntilStage3: true });
      return createElement('span', { 'data-revision': revision });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let finishSnapshot!: () => void;
    mocks.loadWorkspace.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSnapshot = resolve; }));

    await act(async () => {
      root.render(createElement('div', null,
        createElement(MainWorkspaceSync, { key: 'initial', revision: 'initial' }),
        createElement(AgentWindowEffects),
      ));
    });

    expect(mocks.listenWorkspace).toHaveBeenCalledTimes(2);
    await act(async () => mocks.listenWorkspace.mock.calls[0][0]());
    expect(mocks.loadWorkspace).not.toHaveBeenCalled();
    expect(mocks.initializePiMode).not.toHaveBeenCalled();
    expect(mocks.initializeLegacySessionSettings).not.toHaveBeenCalled();
    // 事件订阅是 stage3 之后按需挂载的（它背后是整个 agent-session-store），
    // 所以首帧前不应发生，见下方 admitStartupStage3 之后的断言。
    expect(mocks.useAgentEvents).not.toHaveBeenCalled();
    expect(mocks.acquireMemoEventBridge).toHaveBeenCalledOnce();
    expect(mocks.refreshRuntime).not.toHaveBeenCalled();
    expect(mocks.loadWorkspace).not.toHaveBeenCalled();
    expect(mocks.listenWorkspace).toHaveBeenCalledTimes(2);
    expect(mocks.prewarmNotebookCache).not.toHaveBeenCalled();
    expect(mocks.refreshCloudPiModelProviderAtStartup).not.toHaveBeenCalled();

    await act(async () => admitStartupStage3());
    expect(mocks.loadWorkspace).toHaveBeenCalledOnce();
    expect(mocks.initializePiMode).toHaveBeenCalledOnce();
    expect(mocks.initializeLegacySessionSettings).toHaveBeenCalledOnce();
    expect(mocks.refreshRuntime).toHaveBeenCalledWith({ force: true });
    expect(mocks.prewarmNotebookCache).toHaveBeenCalledOnce();
    expect(mocks.refreshCloudPiModelProviderAtStartup).not.toHaveBeenCalled();
    // stage3 之后懒加载的订阅才挂上（多一次动态 import，需要等一拍）。
    await vi.waitFor(() => expect(mocks.useAgentEvents).toHaveBeenCalledOnce());

    await act(async () => root.render(createElement('div', null,
      createElement(MainWorkspaceSync, { key: 'during', revision: 'during' }),
      createElement(AgentWindowEffects),
    )));
    expect(mocks.loadWorkspace).toHaveBeenCalledOnce();
    await act(async () => mocks.listenWorkspace.mock.calls[2][0]());
    expect(mocks.loadWorkspace).toHaveBeenCalledOnce();

    // Cloud refresh follows authenticated session state, independently of
    // workspace restoration. This snapshot is signed out.
    expect(mocks.refreshCloudPiModelProviderAtStartup).not.toHaveBeenCalled();
    expect(mocks.refreshAgentModelCatalog).not.toHaveBeenCalled();

    await act(async () => finishSnapshot());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(2);

    mocks.listenWorkspace.mockImplementationOnce((_reload, { onListenerReady }) => {
      onListenerReady();
      return mocks.unlistenWorkspace;
    });
    await act(async () => root.render(createElement('div', null,
      createElement(MainWorkspaceSync, { key: 'after', revision: 'after' }),
      createElement(AgentWindowEffects),
    )));
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(3);
    await act(async () => mocks.listenWorkspace.mock.calls[mocks.listenWorkspace.mock.calls.length - 1][0]());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(4);

    await act(async () => root.unmount());
    expect(mocks.unlistenWorkspace).toHaveBeenCalledTimes(4);
    expect(mocks.releaseMemoEventBridge).toHaveBeenCalledOnce();
  });

  it('refreshes the Pi catalog on login and ignores an older signed-out snapshot', async () => {
    let resolveInitialSnapshot!: (state: CloudState) => void;
    mocks.getCloudState.mockImplementationOnce(() => new Promise((resolve) => {
      resolveInitialSnapshot = resolve;
    }));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(AgentWindowEffects)));
    // 首帧快照现在由 stage3 统一触发（cloud/model catalog 那条链是懒加载的）。
    await act(async () => admitStartupStage3());
    await vi.waitFor(() => expect(mocks.getCloudState).toHaveBeenCalledOnce());

    const signedIn = {
      revision: 2,
      authenticated: true,
      authStatus: 'authenticated' as const,
      account: {
        user: { id: 'user-1', email: 'member@example.com', displayName: 'Member', region: 'mainland' as const },
        protocolEpoch: 3 as const,
      },
    };
    await act(async () => mocks.cloudStateHandler?.(signedIn));
    // 目录同步走动态 import：事件回调返回只是入队，真正的调用在下一拍。
    // setPiCloudAccount 的签名带第三个可选参数 membership；该状态没有会员信息，
    // 因此调用方显式传 undefined，断言按真实签名书写。
    await vi.waitFor(() => {
      expect(mocks.setPiCloudAccount).toHaveBeenCalledWith('user-1', 2, undefined);
      expect(mocks.refreshCloudPiModelProviderAtStartup).toHaveBeenCalledOnce();
      expect(mocks.refreshAgentModelCatalog).toHaveBeenCalledWith('pi');
    });

    await act(async () => resolveInitialSnapshot({
      revision: 1,
      authenticated: false,
      authStatus: 'signed_out',
    }));
    expect(mocks.setPiCloudAccount).toHaveBeenCalledTimes(1);
    expect(mocks.piCloudAccountId).toBe('user-1');

    await act(async () => mocks.cloudStateHandler?.({
      revision: 3,
      authenticated: false,
      authStatus: 'signed_out',
    }));
    await vi.waitFor(() => {
      expect(mocks.setPiCloudAccount).toHaveBeenLastCalledWith(null, 3, undefined);
    });
    expect(mocks.piCloudAccountId).toBeNull();

    await act(async () => root.unmount());
    expect(mocks.unlistenCloudState).toHaveBeenCalledOnce();
  });
});
