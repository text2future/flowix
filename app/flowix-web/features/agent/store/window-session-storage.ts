import { STORAGE_KEYS } from "@/lib/constants";
import {
  DEFAULT_AGENT_SESSION_META,
  type AgentSessionMeta,
} from "@features/agent/store/session-state";
import { getCurrentWindow } from "@platform/tauri/window";
import type { StateStorage } from "zustand/middleware";

type PersistEnvelope = {
  state?: { sessionMeta?: Partial<AgentSessionMeta> };
  version?: number;
};

export function agentWindowSessionStorageKey(windowLabel: string): string {
  const normalized = windowLabel.trim() || "main";
  return `${STORAGE_KEYS.AGENT_SESSION}:window:${encodeURIComponent(normalized)}`;
}

export function currentAgentWindowLabel(): string {
  try {
    return getCurrentWindow().label.trim() || "main";
  } catch {
    return "main";
  }
}

function parseEnvelope(raw: string | null): PersistEnvelope | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PersistEnvelope;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function envelope(meta: Partial<AgentSessionMeta>, version?: number): string {
  return JSON.stringify({ state: { sessionMeta: meta }, version });
}

/**
 * Multiplex Zustand persistence across two ownership domains:
 * - localStorage: settings and cross-window thread routing;
 * - sessionStorage: navigation owned by this Webview.
 *
 * `lastSeenSettings` prevents an unrelated navigation update in a stale
 * Webview from writing an old settings snapshot over a newer global value.
 */
export function createAgentSessionStateStorage(
  windowLabel = currentAgentWindowLabel(),
): StateStorage {
  const windowKey = agentWindowSessionStorageKey(windowLabel);
  let lastSeenSettings = "";

  return {
    getItem(name) {
      const globalEnvelope = parseEnvelope(localStorage.getItem(name));
      const globalMeta = globalEnvelope?.state?.sessionMeta ?? {};
      const windowEnvelope = parseEnvelope(sessionStorage.getItem(windowKey));
      const windowMeta = windowEnvelope?.state?.sessionMeta;
      lastSeenSettings = JSON.stringify(
        globalMeta.settings ?? DEFAULT_AGENT_SESSION_META.settings,
      );

      const local = windowMeta ?? {};
      if (!globalEnvelope && !windowEnvelope) return null;
      return envelope(
        {
          settings: globalMeta.settings,
          threadTypes: globalMeta.threadTypes,
          externalSessionResolutions: globalMeta.externalSessionResolutions,
          activeAgentTypeKey: local.activeAgentTypeKey,
          activeThreadIds: local.activeThreadIds,
          currentThreadTitles: local.currentThreadTitles,
        },
        globalEnvelope?.version ?? windowEnvelope?.version,
      );
    },

    setItem(name, value) {
      const incomingEnvelope = parseEnvelope(value);
      const incoming = incomingEnvelope?.state?.sessionMeta ?? {};
      const currentEnvelope = parseEnvelope(localStorage.getItem(name));
      const current = currentEnvelope?.state?.sessionMeta ?? {};
      const incomingSettings = JSON.stringify(incoming.settings ?? {});
      const settingsChangedHere = incomingSettings !== lastSeenSettings;

      const globalMeta: Partial<AgentSessionMeta> = {
        settings: settingsChangedHere ? incoming.settings : current.settings,
        // Routing knowledge is monotonic during normal operation. Merging
        // avoids one Webview erasing mappings learned by another.
        threadTypes: { ...(current.threadTypes ?? {}), ...(incoming.threadTypes ?? {}) },
        externalSessionResolutions: {
          ...(current.externalSessionResolutions ?? {}),
          ...(incoming.externalSessionResolutions ?? {}),
        },
      };
      localStorage.setItem(name, envelope(globalMeta, incomingEnvelope?.version));
      if (settingsChangedHere) lastSeenSettings = incomingSettings;

      sessionStorage.setItem(
        windowKey,
        envelope(
          {
            activeAgentTypeKey: incoming.activeAgentTypeKey,
            activeThreadIds: incoming.activeThreadIds,
            currentThreadTitles: incoming.currentThreadTitles,
          },
          incomingEnvelope?.version,
        ),
      );
    },

    removeItem(name) {
      localStorage.removeItem(name);
      sessionStorage.removeItem(windowKey);
    },
  };
}
