/**
 * 瑕嗙洊 "閲嶅惎浜у搧鍚? 宸插瓨鍦ㄧ殑 thread card resume 鏃?cwd 缂哄け" 杩欐潯淇璺緞.
 *
 * 鍏抽敭涓嶅彉閲?
 *   buildInitialInstanceRuntimeConfig() 蹇呰繑鍥?
 *     - cwd: 鍚屾鍙 selectedNotebook.path (鍗充娇 agent-access-store
 *       杩樺湪 EMPTY_CONFIG 鐘舵€?鈹€鈹€ 鍚姩 race 绐楀彛鍐呯殑鐪熷疄鍦烘櫙)
 *     - files.notebooks / files.folders: 浠?agentAccessStore.enabled
 *       entries 娲剧敓
 *
 * 杩欐槸 instance 鍒涘缓鐬棿鐨?snapshot; 鑰?instance 鐨?backfill 璧板悓涓€浠? * helper 鍚屾钀?SQLite, 瑙?`agent-conversation-store.ts::backfillMissingRuntimeConfig`.
 *
 * 娴嬭瘯绛栫暐: 閫氳繃 `vi.mock` 鎶?store 鍒囧埌 test 鎺у埗涓?鈹€鈹€ 閬垮厤 chat-store
 * / memo-store 寮曞彂鐨?tauri-side 鍓綔鐢?(`listen` 绛? 璇墦鏂祴璇曘€? */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 鐢?vi.hoisted 璁?mocks 鍦ㄦ枃浠堕《灞?hoist 鍚庢敞鍏?鈹€鈹€ 杩欐槸 vitest 閫氱敤妯″紡.
const memoStateMock = vi.hoisted(() => ({
  selectedNotebook: null as null | { id: string; path: string } | unknown,
}));

const accessStateMock = vi.hoisted(() => ({
  config: {
    version: 1,
    entries: [] as Array<{
      id: string;
      kind: "folder" | "notebook";
      path: string;
      enabled: boolean;
      missing: boolean;
    }>,
  },
}));

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => ({
      selectedNotebook: memoStateMock.selectedNotebook,
    }),
  },
}));

vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: {
    getState: () => ({
      config: accessStateMock.config,
    }),
  },
}));

const conversationStateMock = vi.hoisted(() => ({
  instances: {} as Record<string, unknown>,
  messageStates: {} as Record<string, unknown>,
}));

vi.mock("@features/agent/store/agent-conversation-store", () => ({
  useAgentConversationStore: {
    getState: () => ({
      instances: conversationStateMock.instances,
      messageStates: conversationStateMock.messageStates,
    }),
    setState: (updater: unknown) => {
      // Tests 璋冪敤 setState({ instances: {...}, messageStates: {...} }) (object 褰㈠紡)
      // 鏃舵妸 partial 鍚堝苟杩?conversationStateMock銆?    
      if (typeof updater === "object" && updater !== null) {
        const patch = updater as {
          instances?: Record<string, unknown>;
          messageStates?: Record<string, unknown>;
        };
        if (patch.instances) {
          // 鎶?patch.instances 涓虹┖鐨勮涓?reset 鈹€鈹€ beforeEach 蹇呴』鐪熸竻绌?
          // 鍚﹀垯涓婁竴娆＄殑 instance 浼氭薄鏌撲笅涓€鏉?case.
          if (Object.keys(patch.instances).length === 0) {
            conversationStateMock.instances = {};
          } else {
          conversationStateMock.instances = {
            ...conversationStateMock.instances,
            ...patch.instances,
          };
          }
        }
        if (patch.messageStates) {
          if (Object.keys(patch.messageStates).length === 0) {
            conversationStateMock.messageStates = {};
          } else {
          conversationStateMock.messageStates = {
            ...conversationStateMock.messageStates,
            ...patch.messageStates,
          };
          }
        }
      }
    },
  },
  selectLatestFrozenFileSeed: () => {
    let best: { updatedAt: number; files: { workspace?: string; folders: string[]; notebooks: string[] } } | null = null;
    for (const id of Object.keys(conversationStateMock.instances)) {
      const inst = conversationStateMock.instances[id] as {
        runtimeConfig?: { files?: { _frozen?: boolean; workspace?: string; folders: string[]; notebooks: string[] } };
        updatedAt: number;
      };
      const files = inst?.runtimeConfig?.files;
      if (!files?._frozen) continue;
      if (best === null || inst.updatedAt > best.updatedAt) {
        best = { updatedAt: inst.updatedAt, files: files };
      }
    }
    if (!best) return null;
    return {
      workspace: best.files.workspace,
      folders: best.files.folders,
      notebooks: best.files.notebooks,
    };
  },
}));

type TestEntry = {
  id: string;
  kind: "folder" | "notebook";
  path: string;
  enabled: boolean;
  missing: boolean;
};

function makeEntry(
  overrides: Partial<TestEntry> & { id: string; kind: TestEntry["kind"]; path: string },
): TestEntry {
  return {
    enabled: true,
    missing: false,
    ...overrides,
  };
}

describe("buildInitialInstanceRuntimeConfig", () => {
  beforeEach(() => {
    memoStateMock.selectedNotebook = null;
    accessStateMock.config = { version: 1, entries: [] };
  });

  it("selectedNotebook 宸?hydrate 鏃? 缁欏嚭 cwd + 涓€鑷?cwd 椤跺眰瀛楁", async () => {
    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "/Users/rop/Desktop/Notes/鑿滆氨",
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    expect(config.cwd).toBe("/Users/rop/Desktop/Notes/鑿滆氨");
    expect(config.files?.workspace).toBe("/Users/rop/Desktop/Notes/鑿滆氨");
    // selectedNotebook 娌¤繘 agent-access-store entries 鏃? files.notebooks
    // 涓嶄細鑷姩 unshift, 浣?files.workspace 浠嶆槸 cwd. 杩欐槸涓?    // buildAgentRuntimeConfig 鐨勮璁′竴鑷?鈹€鈹€ workspace 瀛楁鍗曠嫭绠′富鐩綍,
    // folders/notebooks 鏄敤鎴蜂富鍔ㄥ姞杩?access 鐨?entries.
    expect(config.files?.notebooks).toEqual([]);
    expect(config.files?.folders).toEqual([]);
  });

  it("selectedNotebook 杩樻病 hydrate (鍚姩 race) 鏃? 涓嶆姏閿欒€岃繑鍥?cwd=undefined, files 绌?", async () => {
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    // 杩欐槸鍚姩 race 绐楀彛鍐呯殑鐪熷疄鍦烘櫙. helper 蹇呴』涓嶆姏閿? 鍏佽
    // 鍏滃簳閾?(userPayload.systemReminderDirectory / Rust session cwd) 鍏滀綇.
    expect(config.cwd).toBeUndefined();
    expect(config.files?.workspace).toBeUndefined();
    expect(config.files?.notebooks).toEqual([]);
    expect(config.files?.folders).toEqual([]);
  });

  it("agent-access 宸叉湁 enabled entries 鏃? 娲剧敓鍒?folders / notebooks", async () => {
    accessStateMock.config = {
      version: 1,
      entries: [
        makeEntry({
          id: "f1",
          kind: "folder",
          path: "/Users/rop/Desktop/folder-a",
        }),
        makeEntry({
          id: "n1",
          kind: "notebook",
          path: "/Users/rop/Desktop/Notes",
        }),
        makeEntry({
          id: "f2",
          kind: "folder",
          path: "/Users/rop/Desktop/folder-a", // dedupe
        }),
        makeEntry({
          id: "missing",
          kind: "folder",
          path: "/Users/rop/Desktop/ghost",
          missing: true, // missing 鈫?skip
        }),
        makeEntry({
          id: "disabled",
          kind: "folder",
          path: "/Users/rop/Desktop/disabled",
          enabled: false, // disabled 鈫?skip
        }),
      ],
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    expect(config.files?.folders).toEqual(["/Users/rop/Desktop/folder-a"]);
    expect(config.files?.notebooks).toEqual(["/Users/rop/Desktop/Notes"]);
  });

  it("normalizeWorkspacePath 澶勭悊灏鹃儴鏂滄潬, 閬垮厤 cwd 鎷兼帴婕傜Щ", async () => {
    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "/Users/rop/Desktop/misc/",
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    expect(config.cwd).toBe("/Users/rop/Desktop/misc");
    expect(config.files?.workspace).toBe("/Users/rop/Desktop/misc");
  });
});
describe("buildInitialInstanceRuntimeConfig 鈥?frozen seed flow", () => {
  beforeEach(() => {
    memoStateMock.selectedNotebook = null;
    accessStateMock.config = { version: 1, entries: [] };
    // 娓呯┖ conversation store (hydrated state 瀹规槗姹℃煋璺?describe block)
    useAgentConversationStore.setState({
      instances: {},
      messageStates: {},
    });
  });

  it("娌″喕缁?instance 鏃? 璧?selectedNotebook + agent-access 娲剧敓 (鍘熻涓?", async () => {
    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "/Users/rop/Desktop/Notes/鑿滆氨",
    };
    accessStateMock.config = {
      version: 1,
      entries: [
        {
          id: "f-1",
          kind: "folder",
          path: "/Users/rop/Desktop/folder-1",
          enabled: true,
          missing: false,
        },
        {
          id: "n-1",
          kind: "notebook",
          path: "/Users/rop/Desktop/Notes/瀛︿範绗旇",
          enabled: true,
          missing: false,
        },
      ],
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();
    expect(config.cwd).toBe("/Users/rop/Desktop/Notes/鑿滆氨");
    expect(config.files?.workspace).toBe("/Users/rop/Desktop/Notes/鑿滆氨");
    expect(config.files?.folders).toEqual(["/Users/rop/Desktop/folder-1"]);
    expect(config.files?.notebooks).toEqual(["/Users/rop/Desktop/Notes/瀛︿範绗旇"]);
  });

  it("宸叉湁鍐荤粨 instance 鐨?workspace 鏃? 浼樺厛鐢ㄥ喕缁撳€艰€屼笉鏄?selectedNotebook", async () => {
    useAgentConversationStore.setState({
      instances: {
        "inst-a": {
          instanceId: "inst-a",
          agentType: "codex",
          title: "A",
          threadId: "tid-a",
          runtimeConfig: {
            files: {
              workspace: "D:\\user-set",
              folders: [],
              notebooks: [],
              _frozen: true,
            },
          },
          source: { kind: "thread-card" },
          role: null,
          createdAt: 1,
          updatedAt: 100,
        },
      },
      messageStates: {},
    });

    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "D:\\current-notebook",
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();
    expect(config.cwd).toBe("D:\\user-set");
    expect(config.files?.workspace).toBe("D:\\user-set");
  });

  it("澶氫釜 instance 鏃? 鍙栨渶杩?updatedAt 鐨勫喕缁?instance 浣滅瀛?", async () => {
    useAgentConversationStore.setState({
      instances: {
        "inst-old": {
          instanceId: "inst-old",
          agentType: "codex",
          title: "old",
          threadId: "tid-old",
          runtimeConfig: {
            files: {
              workspace: "D:\\old-set",
              folders: [],
              notebooks: [],
              _frozen: true,
            },
          },
          source: { kind: "thread-card" },
          role: null,
          createdAt: 1,
          updatedAt: 50,
        },
        "inst-newer": {
          instanceId: "inst-newer",
          agentType: "codex",
          title: "newer",
          threadId: "tid-newer",
          runtimeConfig: {
            files: {
              workspace: "D:\\newer-set",
              folders: [],
              notebooks: [],
              _frozen: true,
            },
          },
          source: { kind: "thread-card" },
          role: null,
          createdAt: 1,
          updatedAt: 200,
        },
        "inst-not-frozen": {
          instanceId: "inst-not-frozen",
          agentType: "codex",
          title: "unfrozen",
          threadId: "tid-unfrozen",
          runtimeConfig: {
            files: {
              workspace: "D:\\never-frozen",
              folders: [],
              notebooks: [],
            },
          },
          source: { kind: "thread-card" },
          role: null,
          createdAt: 1,
          updatedAt: 1000,
        },
      },
      messageStates: {},
    });

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();
    expect(config.cwd).toBe("D:\\newer-set");
  });

  it("鍐荤粨绉嶅瓙鐨?folders 涓庡叏灞€ enabled folders 鍙栧苟闆嗗幓閲?", async () => {
    useAgentConversationStore.setState({
      instances: {
        "inst-a": {
          instanceId: "inst-a",
          agentType: "codex",
          title: "A",
          threadId: "tid-a",
          runtimeConfig: {
            files: {
              workspace: "D:\\x",
              folders: ["D:\\seed-only"],
              notebooks: ["D:\\seed-notebook"],
              _frozen: true,
            },
          },
          source: { kind: "thread-card" },
          role: null,
          createdAt: 1,
          updatedAt: 100,
        },
      },
      messageStates: {},
    });
    accessStateMock.config = {
      version: 1,
      entries: [
        {
          id: "f-1",
          kind: "folder",
          path: "D:\\seed-only",
          enabled: true,
          missing: false,
        },
        {
          id: "f-2",
          kind: "folder",
          path: "D:\\global-only",
          enabled: true,
          missing: false,
        },
        {
          id: "n-1",
          kind: "notebook",
          path: "D:\\global-notebook",
          enabled: true,
          missing: false,
        },
      ],
    };

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();
    expect(config.files?.folders).toEqual([
      "D:\\seed-only",
      "D:\\global-only",
    ]);
    expect(config.files?.notebooks).toEqual([
      "D:\\seed-notebook",
      "D:\\global-notebook",
    ]);
  });
});
describe("buildInitialInstanceRuntimeConfig 鈥?backfill 鍚屾簮 (鍥炲綊)", () => {
  beforeEach(() => {
    memoStateMock.selectedNotebook = null;
    accessStateMock.config = { version: 1, entries: [] };
    conversationStateMock.instances = {};
    conversationStateMock.messageStates = {};
  });

  it("backfill 璋冪敤涓庢柊寤?instance 鎷垮埌鐩稿悓鐨?seed - 涓?selectLatestFrozenFileSeed 鐩存帴璋冪敤涓€鑷?", async () => {
    // 璁句竴涓?frozen instance (workspace: D:\\frozen-set, folders: [D:\\seed-folder])
    conversationStateMock.instances = {
      "inst-frozen": {
        instanceId: "inst-frozen",
        agentType: "codex",
        title: "Frozen",
        threadId: "tid-frozen",
        runtimeConfig: {
          files: {
            workspace: "D:\\frozen-set",
            folders: ["D:\\seed-folder"],
            notebooks: [],
            _frozen: true,
          },
        },
        source: { kind: "thread-card" },
        role: null,
        createdAt: 1,
        updatedAt: 100,
      },
    };

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    // 杩欐潯鏄?extension insertAgentThreadCard 涓?view ensureInstanceBinding
    // 鍏辩敤鐨?鏂板缓 instance" path 鈹€鈹€ 鐩存帴澶嶇敤鍚屼竴 helper.
    const config = buildInitialInstanceRuntimeConfig();

    expect(config.cwd).toBe("D:\\frozen-set");
    expect(config.files?.workspace).toBe("D:\\frozen-set");
    expect(config.files?.folders).toEqual(["D:\\seed-folder"]);
  });
});
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
describe("buildInitialInstanceRuntimeConfig 鈥?extension.insertAgentThreadCard 绛変环璺緞", () => {
  beforeEach(() => {
    memoStateMock.selectedNotebook = null;
    accessStateMock.config = { version: 1, entries: [] };
    conversationStateMock.instances = {};
    conversationStateMock.messageStates = {};
  });

  it("worker 榛樿 cwd = 'D:\\user-pinned' 鏃? 鏂?instance 鐨?workspace 绛変簬瀹?", async () => {
    // 妯℃嫙 worker 宸茬粨杩?workspace = D:\\user-pinned, 娌′慨鏀?folders/notebooks
    conversationStateMock.instances = {
      "inst-a": {
        instanceId: "inst-a",
        agentType: "codex",
        title: "A",
        threadId: "tid-a",
        runtimeConfig: {
          files: {
            workspace: "D:\\user-pinned",
            folders: ["D:\\a-folder"],
            notebooks: ["D:\\a-notebook"],
            _frozen: true,
          },
        },
        source: { kind: "thread-card" },
        role: null,
        createdAt: 1,
        updatedAt: 200,
      },
    };

    // 鍚屾椂 selectedNotebook 鏄煇涓埆鐨勫€? 涓嶈兘瑕嗙洊 frozen
    memoStateMock.selectedNotebook = {
      id: "nb-other",
      path: "D:\\another-notebook",
    };

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");
    const config = buildInitialInstanceRuntimeConfig();

    expect(config.cwd).toBe("D:\\user-pinned");
    expect(config.files?.workspace).toBe("D:\\user-pinned");
    // folders/notebooks 鍙栧苟闆?  
    expect(config.files?.folders).toContain("D:\\a-folder");
    expect(config.files?.notebooks).toContain("D:\\a-notebook");
  });

  it("worker 鏈喕缁? 璧?selectedNotebook + 绗竴涓?enabled folder", async () => {
    // selectedNotebook 宸?hydrate, 鏄彧璇荤殑銆岄€変腑銆嶈涔夋潵婧?
    memoStateMock.selectedNotebook = {
      id: "nb-1",
      path: "D:\\current",
    };
    accessStateMock.config = {
      version: 1,
      entries: [
        {
          id: "f-1",
          kind: "folder",
          path: "D:\\flowix",
          enabled: true,
          missing: false,
        },
      ],
    };

    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");
    const config = buildInitialInstanceRuntimeConfig();

    // 娌″喕缁?鈫?workspace 鍙?selectedNotebook
    expect(config.cwd).toBe("D:\\current");
    expect(config.files?.workspace).toBe("D:\\current");
    // folders 杩樻槸浠?enabled 鎷?  
    expect(config.files?.folders).toEqual(["D:\\flowix"]);
  });
});



