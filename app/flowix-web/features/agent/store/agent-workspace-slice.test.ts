import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWorkspaceSnapshot, NotebookWorkspaceConfig } from "@/lib/types/agent-workspace";
import { STORAGE_KEYS } from "@/lib/constants";

const backend = vi.hoisted(() => ({ get: vi.fn(), attachDirectory: vi.fn(), detachDirectory: vi.fn(), pickDirectory: vi.fn() }));
const piBackend = vi.hoisted(() => ({ getFeatures: vi.fn(), clearLegacyCodeMode: vi.fn() }));
const sessionState = vi.hoisted(() => ({ settings: {} as Record<string, string> }));
vi.mock("@platform/tauri/client", () => ({ agentWorkspace: backend, piModels: piBackend }));
vi.mock("./agent-session-store", () => ({ useAgentSessionStore: { getState: () => ({ sessionMeta: { settings: sessionState.settings } }) } }));
import { ensureAgentPreferencesReady, useAgentDataStore } from "./agent-data-store";
import { ensureAgentWorkspaceReady, useAgentWorkspaceStore } from "./agent-workspace-store";

const notebook = (id: string) => ({ id, kind: "notebook" as const, path: `/notes/${id}`, name: id, enabled: true, missing: false, addedAt: 1, updatedAt: 1 });
const resource = { ...notebook("resource"), kind: "folder" as const, path: "/projects/shared" };
const localConfig: NotebookWorkspaceConfig = { version: 1, revision: 1, addDirs: [{ id: "dir", path: resource.path, label: "Shared", enabled: true }] };
const snapshot = (): AgentWorkspaceSnapshot => ({ notebooks: [notebook("one"), notebook("two")], notebookConfigs: { one: structuredClone(localConfig), two: { version: 1, revision: 0, addDirs: [] } } });

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useAgentDataStore.setState(useAgentDataStore.getInitialState(), true);
  useAgentWorkspaceStore.setState(useAgentWorkspaceStore.getInitialState(), true);
  vi.resetAllMocks();
  backend.get.mockImplementation(async () => snapshot());
  sessionState.settings = {};
  piBackend.getFeatures.mockResolvedValue({ toolSearch: false });
  piBackend.clearLegacyCodeMode.mockResolvedValue(undefined);
});

describe("Pi mode startup migration", () => {
  it("treats reselecting the default as an explicit choice ahead of a late migration", async () => {
    await useAgentDataStore.getState().initializePiMode();
    useAgentDataStore.getState().setUserPreference("pi", { mode: "writing" });
    const otherWindow = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA)!);
    otherWindow.state.agents.pi.user.mode = "code";
    otherWindow.state.userPreferenceRevisions.pi.mode = "0000000000000:legacy";
    localStorage.setItem(STORAGE_KEYS.AGENT_DATA, JSON.stringify(otherWindow));
    await useAgentDataStore.persist.rehydrate();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("writing");
  });

  it("keeps another window's migrated mode before its storage event arrives", async () => {
    useAgentDataStore.setState({ legacyPreferencesMigrated: true });
    let finish!: (features: { toolSearch: boolean }) => void;
    piBackend.getFeatures.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const initializing = useAgentDataStore.getState().initializePiMode();
    const otherWindow = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA)!);
    otherWindow.state.agents.pi.user.mode = "code";
    otherWindow.state.userPreferenceRevisions.pi = { mode: "0000000000000:legacy" };
    localStorage.setItem(STORAGE_KEYS.AGENT_DATA, JSON.stringify(otherWindow));
    finish({ toolSearch: false });
    await initializing;
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("code");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA)!).state.agents.pi.user.mode).toBe("code");
  });

  it("gives an imported mode priority over a stale default from another window", async () => {
    await useAgentDataStore.getState().initializePiMode();
    const staleDefault = localStorage.getItem(STORAGE_KEYS.AGENT_DATA)!;
    const imported = JSON.parse(staleDefault);
    imported.state.agents.pi.user.mode = "code";
    imported.state.userPreferenceRevisions.pi.mode = "0000000000000:legacy";
    localStorage.setItem(STORAGE_KEYS.AGENT_DATA, JSON.stringify(imported));
    await useAgentDataStore.persist.rehydrate();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("code");
    localStorage.setItem(STORAGE_KEYS.AGENT_DATA, staleDefault);
    await useAgentDataStore.persist.rehydrate();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("code");
  });

  it("uses an existing shared choice without reading legacy settings, even if cleanup fails", async () => {
    useAgentDataStore.getState().setUserPreference("pi", { mode: "writing" });
    piBackend.getFeatures.mockRejectedValue(new Error("old settings unavailable"));
    piBackend.clearLegacyCodeMode.mockRejectedValue(new Error("cleanup unavailable"));
    await useAgentDataStore.getState().initializePiMode();
    expect(piBackend.getFeatures).not.toHaveBeenCalled();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("writing");
    expect(useAgentDataStore.getState().loadState.piMode.status).toBe("ready");
  });

  it("imports the former Pi feature before notebook hydration and only cleans up a durable copy", async () => {
    piBackend.getFeatures.mockResolvedValue({ toolSearch: true, legacyCodeMode: true });
    piBackend.clearLegacyCodeMode.mockImplementation(async () => {
      const persisted = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA)!);
      expect(persisted.state.agents.pi.user.mode).toBe("code");
    });
    await useAgentDataStore.getState().initializePiMode();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("code");
    expect(useAgentDataStore.getState().loadState.piMode.status).toBe("ready");
    expect(useAgentWorkspaceStore.getState().loadState.workspace.status).toBe("idle");
    expect(backend.get).not.toHaveBeenCalled();
    expect(piBackend.clearLegacyCodeMode).toHaveBeenCalledOnce();
  });

  it("uses the Pi feature's retained mode without Agent runtime defaults", async () => {
    piBackend.getFeatures.mockResolvedValue({ toolSearch: false, legacyCodeMode: true });
    await useAgentDataStore.getState().initializePiMode();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("code");
  });

  it("deduplicates initialization and preserves a choice made while migration is reading", async () => {
    let resolve!: (features: { toolSearch: boolean; legacyCodeMode: boolean }) => void;
    piBackend.getFeatures.mockReturnValue(new Promise((done) => { resolve = done; }));
    const first = useAgentDataStore.getState().initializePiMode();
    const second = useAgentDataStore.getState().initializePiMode();
    useAgentDataStore.getState().setUserPreference("pi", { mode: "writing" });
    resolve({ toolSearch: false, legacyCodeMode: true });
    await Promise.all([first, second]);
    expect(piBackend.getFeatures).toHaveBeenCalledOnce();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("writing");
  });

  it("keeps the legacy value when browser persistence fails", async () => {
    piBackend.getFeatures.mockResolvedValue({ toolSearch: false, legacyCodeMode: true });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    await useAgentDataStore.getState().initializePiMode();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("code");
    expect(piBackend.clearLegacyCodeMode).not.toHaveBeenCalled();
  });

  it("retries a failed migration without deleting the old preference", async () => {
    piBackend.getFeatures.mockRejectedValueOnce(new Error("read failed"));
    await expect(useAgentDataStore.getState().initializePiMode()).rejects.toThrow("read failed");
    expect(useAgentDataStore.getState().loadState.piMode.status).toBe("error");
    expect(piBackend.clearLegacyCodeMode).not.toHaveBeenCalled();
    await useAgentDataStore.getState().initializePiMode();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("writing");
  });
});


describe("local.db workspace projection", () => {
  it("derives resources from mounts and excludes missing/disabled paths from runs", async () => {
    const data = snapshot();
    data.notebookConfigs.one.addDirs.push(
      { id: 'missing', path: '/missing', label: 'Missing', enabled: true, missing: true },
      { id: 'disabled', path: '/disabled', label: 'Disabled', enabled: false },
    );
    backend.get.mockResolvedValue(data);
    expect(useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles('one')).toBeUndefined();
    await useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
    expect(useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles('one')?.folders).toEqual([resource.path]);
    expect(useAgentWorkspaceStore.getState().workspace.resources).toHaveLength(3);
  });
  it("never persists or rehydrates a stale workspace cache", async () => {
    await useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA)!);
    expect(persisted.state.workspace).toBeUndefined();
    expect(persisted.state.agents.codex.catalog.capabilities).toBeUndefined();
    const current = useAgentWorkspaceStore.getState().workspace;
    persisted.state.workspace = { resources: [], byNotebookId: {}, validatedAt: Date.now()+1000 };
    localStorage.setItem(STORAGE_KEYS.AGENT_DATA,JSON.stringify(persisted));
    await useAgentDataStore.persist.rehydrate();
    expect(useAgentWorkspaceStore.getState().workspace).toBe(current);
  });
  it.each(['attach-first','detach-first'])("serializes opposite path operations: %s", async order => {
    const data = snapshot();
    backend.attachDirectory.mockImplementation(async (id,path) => {
      data.notebookConfigs[id].addDirs = [{ id:'saved', path, label:'Shared', enabled:true }];
      return structuredClone(data);
    });
    backend.detachDirectory.mockImplementation(async id => {
      data.notebookConfigs[id].addDirs=[];
      return structuredClone(data);
    });
    await useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
    const actions = useAgentWorkspaceStore.getState().workspaceActions;
    await Promise.all(order==='attach-first' ? [actions.attachFolderToNotebook('two',resource.path),actions.detachFolderFromNotebook('two',resource.path)] : [actions.detachFolderFromNotebook('one',resource.path),actions.attachFolderToNotebook('one',resource.path)]);
    expect(actions.getNotebookFiles(order==='attach-first'?'two':'one')?.folders).toEqual(order==='attach-first'?[]:[resource.path]);
  });
  it("picks and mounts in one scoped call without creating a global resource", async () => {
    const data = snapshot();
    data.notebookConfigs.two.addDirs=structuredClone(localConfig.addDirs);
    backend.pickDirectory.mockResolvedValue(data);
    expect((await useAgentWorkspaceStore.getState().workspaceActions.addFolderFromPicker(null)).ok).toBe(false);
    expect(backend.pickDirectory).not.toHaveBeenCalled();
    expect((await useAgentWorkspaceStore.getState().workspaceActions.addFolderFromPicker('two')).ok).toBe(true);
    expect(backend.pickDirectory).toHaveBeenCalledWith('two');
    expect(backend.attachDirectory).not.toHaveBeenCalled();
    expect(useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles('two')?.folders).toEqual([resource.path]);
  });
  it("ignores a read started before a committed mutation", async () => {
    await useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
    let finish!: (data: AgentWorkspaceSnapshot) => void;
    backend.get.mockReturnValueOnce(new Promise<AgentWorkspaceSnapshot>(resolve => {finish=resolve;}));
    const reading=useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
    const saved=snapshot(); saved.notebookConfigs.one.addDirs=[];
    backend.detachDirectory.mockResolvedValue(saved);
    await useAgentWorkspaceStore.getState().workspaceActions.detachFolderFromNotebook('one',resource.path);
    finish(snapshot()); await reading;
    expect(useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles('one')?.folders).toEqual([]);
  });
  it("migrates Codex session settings into the unified user preference store", async () => {
    sessionState.settings = {
      agentCodexModel: "legacy-model",
      agentPermissionMode: "workspace-write",
      agentCodexReasoningEffort: "high",
    };
    await useAgentDataStore.getState().initializeLegacySessionSettings();
    expect(useAgentDataStore.getState().agents.codex.user.model?.id).toBe('legacy-model');
    expect(useAgentDataStore.getState().agents.codex.user.permission).toBe("workspace-write");
    expect(useAgentDataStore.getState().agents.codex.user.reasoningEffort).toBe("high");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA)!).state.legacyPreferencesMigrated).toBe(true);
  });
  it("applies retained Codex session settings before preparing an Agent request", async () => {
    sessionState.settings = {
      agentCodexModel: "legacy-model",
      agentPermissionMode: "workspace-write",
      agentCodexReasoningEffort: "medium",
    };
    await ensureAgentPreferencesReady("codex");
    expect(useAgentDataStore.getState().agents.codex.user.model?.id).toBe("legacy-model");
  });
  it("reports a database failure and retries", async () => {
    backend.get.mockRejectedValueOnce(new Error('database unavailable'));
    await useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
    expect(useAgentWorkspaceStore.getState().loadState.workspace.status).toBe('error');
    await useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
    expect(useAgentWorkspaceStore.getState().loadState.workspace.status).toBe('ready');
  });
});

it("waits for initial database hydration before allowing a workspace snapshot", async () => {
  let finish!: (snapshot: AgentWorkspaceSnapshot) => void;
  backend.get.mockReturnValueOnce(new Promise<AgentWorkspaceSnapshot>(resolve => { finish=resolve; }));
  const ready = ensureAgentWorkspaceReady();
  expect(useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles('one')).toBeUndefined();
  finish(snapshot()); await ready;
  expect(useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles('one')?.folders).toEqual([resource.path]);
});

it("loads database mounts independently from session preference initialization", async () => {
  expect(await useAgentWorkspaceStore.getState().workspaceActions.loadInitial()).toBe(true);
  await ensureAgentPreferencesReady("codex");
  expect(useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles('one')?.folders).toEqual([resource.path]);
});

it("waits for the newer startup read when its own read was superseded", async () => {
  let first!: (data: AgentWorkspaceSnapshot) => void;
  let second!: (data: AgentWorkspaceSnapshot) => void;
  backend.get.mockReturnValueOnce(new Promise<AgentWorkspaceSnapshot>(resolve => { first=resolve; }));
  backend.get.mockReturnValueOnce(new Promise<AgentWorkspaceSnapshot>(resolve => { second=resolve; }));
  const ready=ensureAgentWorkspaceReady();
  const newer=useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
  first(snapshot());
  await Promise.resolve(); await Promise.resolve();
  second(snapshot());
  await Promise.all([ready,newer]);
  expect(useAgentWorkspaceStore.getState().loadState.workspace.status).toBe('ready');
});

describe("saved settings workspace snapshot", () => {
  it("keeps the committed snapshot when an older background reload completes", async () => {
    let finish!: (value: AgentWorkspaceSnapshot) => void;
    backend.get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const loading = useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
    const committed = snapshot();
    committed.notebooks[0].path = "/new-primary";
    committed.notebookConfigs.one.addDirs = [];
    useAgentWorkspaceStore.getState().workspaceActions.applySnapshot(committed);
    finish(snapshot());
    await loading;
    const state = useAgentWorkspaceStore.getState();
    expect(state.workspace.byNotebookId.one.notebook.path).toBe("/new-primary");
    expect(state.workspace.byNotebookId.one.addDirs).toEqual([]);
    expect(state.loadState.workspace.status).toBe("ready");
  });
});
