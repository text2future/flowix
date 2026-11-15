import { useSyncExternalStore } from 'react';
import { normalizeAgentId, type AgentTypeKey } from '@/lib/agent-types';

const STORAGE_KEY = 'flowix:agent:selected-type:v1';
const LEGACY_STORAGE_KEY = 'flowix:collection:agent-type-by-host:v1';
const DEFAULT_AGENT_TYPE: AgentTypeKey = 'pi';
const listeners = new Set<() => void>();

let selectedAgentType: AgentTypeKey | undefined;
let storageLoaded = false;
let storageListenerAttached = false;

function parseAgentType(value: unknown): AgentTypeKey | undefined {
  return typeof value === 'string' ? normalizeAgentId(value) ?? undefined : undefined;
}

function readPersistedAgentType(): AgentTypeKey | undefined {
  try {
    const stored = parseAgentType(window.localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;

    // Migrate the former per-column preference, preferring the primary column.
    const rawLegacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!rawLegacy) return undefined;
    const legacy: unknown = JSON.parse(rawLegacy);
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return undefined;
    const values = legacy as Record<string, unknown>;
    return parseAgentType(values['column-1']) ?? parseAgentType(values['column-2']);
  } catch {
    // Preferences are optional; malformed or unavailable storage uses defaults.
    return undefined;
  }
}

function loadStorageOnce(): void {
  if (storageLoaded || typeof window === 'undefined') return;
  storageLoaded = true;
  selectedAgentType = readPersistedAgentType();
  if (selectedAgentType) persistAgentType();
}

function persistAgentType(): void {
  if (typeof window === 'undefined' || !selectedAgentType) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, selectedAgentType);
  } catch {
    // A disabled or full localStorage must not block changing the selected agent.
  }
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function handleStorageChange(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== LEGACY_STORAGE_KEY && event.key !== null) return;
  selectedAgentType = readPersistedAgentType();
  notify();
}

export function getCollectionAgentType(): AgentTypeKey {
  loadStorageOnce();
  return selectedAgentType ?? DEFAULT_AGENT_TYPE;
}

export function setCollectionAgentType(agentType: AgentTypeKey): void {
  loadStorageOnce();
  const normalized = parseAgentType(agentType);
  if (!normalized || getCollectionAgentType() === normalized) return;
  selectedAgentType = normalized;
  persistAgentType();
  notify();
}

function subscribe(listener: () => void): () => void {
  loadStorageOnce();
  if (!storageListenerAttached && typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorageChange);
    storageListenerAttached = true;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCollectionAgentType(): AgentTypeKey {
  return useSyncExternalStore(
    subscribe,
    getCollectionAgentType,
    () => DEFAULT_AGENT_TYPE,
  );
}
