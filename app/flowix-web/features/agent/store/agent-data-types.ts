import type { CloudMembership } from "@platform/tauri/client";
import type { AgentCodexReasoningEffort, AgentCodexServiceTier, AgentPermissionMode, AgentTypeKey } from "@/types/agent";
import type { AgentAccessOption, AgentModeOption } from "@features/agent/runtime/agent-runtime-spec";

export interface AgentCatalogModel {
  source?: "flowix-cloud" | "custom";
  id: string;
  label: string;
  description?: string;
  subtitle?: string;
  tags?: string[];
  creditMultiplier?: number;
  reasoningConfig?: { levels: string[]; defaultLevel?: string | null };
  iconUrl?: string;
  /** Cloud directory rank: larger values are shown first. */
  sortOrder?: number;
  recommended?: boolean;
  providerId?: string;
  providerName?: string;
  reasoningEfforts?: AgentCodexReasoningEffort[];
}

export interface AgentCatalogSkill {
  name: string;
  description: string;
  displayName?: string;
  shortDescription?: string;
  whenToUse?: string;
  modelInvocable?: boolean;
  scope?: string;
  path?: string;
  enabled?: boolean;
}

export interface AgentModelCatalog {
  items: AgentCatalogModel[];
  defaultModel?: string;
  defaultProviderId?: string;
  updatedAt?: number;
}

export interface AgentCapabilities {
  permissions: readonly AgentAccessOption[];
  modes: readonly AgentModeOption[];
}

export interface AgentUserPreference {
  model?: { id: string; providerId?: string };
  permission?: AgentPermissionMode;
  mode?: string;
  reasoningEffort?: AgentCodexReasoningEffort;
  reasoningByModel?: Record<string, AgentCodexReasoningEffort>;
  serviceTier?: AgentCodexServiceTier;
}

export interface AgentCatalogState {
  models: AgentModelCatalog;
  skillsByNotebookId: Record<string, {
    items: AgentCatalogSkill[];
    updatedAt?: number;
  }>;
  /** Built from the current runtime spec and omitted from the persisted snapshot. */
  capabilities: AgentCapabilities;
}

export interface AgentDataRecord {
  catalog: AgentCatalogState;
  user: AgentUserPreference;
}

export interface AgentDataLoadState {
  piMode: { status: 'idle' | 'loading' | 'ready' | 'error'; error?: string };
  piCloudModels: { status: 'idle' | 'loading' | 'ready' | 'error'; error?: string };
}

export interface AgentDataStoreState {
  /** One-time import of legacy Codex session settings. */
  legacyPreferencesMigrated: boolean;
  /** Per-field revisions make user choices mergeable across app windows. */
  userPreferenceRevisions: Partial<Record<AgentTypeKey, Record<string, string>>>;
  /** Flowix Cloud Pi models belong to the current account session, not disk. */
  piCloudAccountId: string | null;
  piCloudRegion: "mainland" | "non_mainland" | null;
  /** Latest membership entitlement included in the native Cloud state snapshot. */
  piCloudMembership: CloudMembership | null;
  piCloudCatalogEpoch: number;
  piCloudRevision: number;
  /** Transient UI status; deliberately excluded from localStorage. */
  persistenceError: string | null;
  agents: Record<AgentTypeKey, AgentDataRecord>;
  loadState: AgentDataLoadState;
  initializePiMode: () => Promise<void>;
  initializeLegacySessionSettings: () => Promise<void>;
  setModelCatalog: (agentType: AgentTypeKey, catalog: AgentModelCatalog) => void;
  invalidateModelCatalog: (agentType: AgentTypeKey) => void;
  setPiCloudAccount: (
    accountId: string | null,
    revision?: number,
    membership?: CloudMembership | null,
    region?: "mainland" | "non_mainland" | null,
  ) => void;
  setPiCloudModelLoadState: (epoch: number, state: AgentDataLoadState["piCloudModels"]) => void;
  invalidateSkillCatalog: (agentType: AgentTypeKey, notebookId: string) => void;
  loadModelCatalog: (
    agentType: AgentTypeKey,
    loader: () => Promise<AgentModelCatalog>,
    options?: { force?: boolean; maxAgeMs?: number },
  ) => Promise<AgentModelCatalog>;
  setSkillCatalog: (
    agentType: AgentTypeKey,
    notebookId: string,
    items: AgentCatalogSkill[],
  ) => void;
  loadSkillCatalog: (
    agentType: AgentTypeKey,
    notebookId: string,
    loader: () => Promise<AgentCatalogSkill[]>,
    options?: { force?: boolean; maxAgeMs?: number },
  ) => Promise<AgentCatalogSkill[]>;
  setUserPreference: (
    agentType: AgentTypeKey,
    patch: Partial<AgentUserPreference>,
  ) => void;
  rememberModelReasoning: (
    agentType: AgentTypeKey,
    model: { id: string; providerId?: string } | undefined,
    effort: AgentCodexReasoningEffort,
  ) => void;
  migrateLegacySessionSettings: (codexSessionSettings?: {
    agentCodexModel: string;
    agentPermissionMode: AgentPermissionMode;
    agentCodexReasoningEffort: AgentCodexReasoningEffort;
  }) => void;
}
