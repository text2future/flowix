import * as React from "react";
import type { UsageInfo } from "@/types/agent";
import type { CodexRuntimeInfo } from "@platform/tauri/client/agent";

export interface BadgeHoverCardRuntimeInfo {
  model?: string;
  usage: UsageInfo;
  codex?: CodexRuntimeInfo;
  /** Provider-owned session id; the local Flowix thread id is never displayed. */
  sessionId?: string;
}

interface UseBadgeRuntimeInfoOptions {
  identity: string;
  model?: string;
  usage?: UsageInfo;
  refreshOnRequest?: boolean;
  sessionId?: string;
  onRequest?: () => Promise<BadgeHoverCardRuntimeInfo | null>;
}

interface RuntimeInfoSnapshot {
  identity: string;
  info: BadgeHoverCardRuntimeInfo | null;
}

interface RuntimeInfoRequest {
  identity: string;
  promise: Promise<BadgeHoverCardRuntimeInfo | null>;
}

function mergeUsage(
  fetched: UsageInfo | undefined,
  current: UsageInfo | undefined,
): UsageInfo | undefined {
  if (!fetched) return current;
  if (!current) return fetched;
  const currentValues = Object.fromEntries(
    Object.entries(current).filter(([, value]) => value !== undefined && value !== null),
  );
  return { ...fetched, ...currentValues } as UsageInfo;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/** Keeps async provider reads scoped to one conversation and merges them as fallback data. */
export function useBadgeRuntimeInfo({
  identity,
  model,
  usage,
  refreshOnRequest = false,
  sessionId,
  onRequest,
}: UseBadgeRuntimeInfoOptions) {
  const [snapshot, setSnapshot] = React.useState<RuntimeInfoSnapshot | null>(null);
  const [pending, setPending] = React.useState(() => ({
    identity,
    value: Boolean(onRequest),
  }));
  const currentIdentityRef = React.useRef(identity);
  const loadedIdentityRef = React.useRef<string | null>(null);
  const requestRef = React.useRef<RuntimeInfoRequest | null>(null);
  currentIdentityRef.current = identity;

  React.useEffect(() => {
    setPending((current) => current.identity === identity
      ? current
      : { identity, value: Boolean(onRequest) });
  }, [identity, onRequest]);

  const requestRuntimeInfo = React.useCallback(() => {
    if (!onRequest || (!refreshOnRequest && loadedIdentityRef.current === identity)) return;
    if (requestRef.current?.identity === identity) return;

    let promise: Promise<BadgeHoverCardRuntimeInfo | null>;
    try {
      promise = Promise.resolve(onRequest());
    } catch {
      setPending((current) => current.identity === identity
        ? { identity, value: false }
        : current);
      return;
    }
    const request = { identity, promise };
    requestRef.current = request;
    setPending({ identity, value: true });

    void promise
      .then((info) => {
        if (currentIdentityRef.current !== identity) return;
        loadedIdentityRef.current = identity;
        setSnapshot({ identity, info });
      })
      .catch(() => {
        // Keep the current snapshot; a later hover can retry the read.
      })
      .finally(() => {
        if (requestRef.current === request) requestRef.current = null;
        if (currentIdentityRef.current === identity) {
          setPending((current) => current.identity === identity
            ? { identity, value: false }
            : current);
        }
      });
  }, [identity, onRequest, refreshOnRequest]);

  const fetched = snapshot?.identity === identity ? snapshot.info : null;
  const displayModel = nonEmpty(model) ?? nonEmpty(fetched?.model);
  const displayUsage = mergeUsage(fetched?.usage, usage);
  const displaySessionId = sessionId ?? fetched?.sessionId ?? null;

  return {
    displayModel,
    displayUsage,
    displaySessionId,
    codexInfo: fetched?.codex,
    runtimeInfoPending: Boolean(onRequest) && pending.identity === identity && pending.value,
    requestRuntimeInfo,
  };
}
