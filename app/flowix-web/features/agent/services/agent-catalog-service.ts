import type { AgentCodexReasoningEffort, AgentTypeKey } from "@/types/agent";
import { getFallbackAgentModelOptions } from "@features/agent/config/agent-model-options";
import { formatModelDisplayLabel } from "@features/agent/config/codex-options";
import { listCodexSkillCatalog } from "@features/agent/services/codex-slash-command-service";
import { listPiSkills } from "@features/agent/services/pi-slash-command-service";
import { byModelOrder, withCachedGuestCloudModels } from "@features/agent/services/pi-public-catalog";
import {
  type AgentCatalogModel,
  type AgentCatalogSkill,
  type AgentModelCatalog,
  useAgentDataStore,
} from "@features/agent/store/agent-data-store";
import { agent, deepseekHarness, piModels } from "@platform/tauri/client";

import { createLogger } from '@/lib/logger';
const logger = createLogger('agent-catalog');
const SUPPORTED_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** Loads a provider catalog through the shared persistent cache. */
export function loadAgentModelCatalog(
  agentType: AgentTypeKey,
  options: { force?: boolean } = {},
): Promise<AgentModelCatalog> {
  const store = useAgentDataStore.getState();
  return store.loadModelCatalog(
    agentType,
    () => fetchAgentModelCatalog(agentType),
    { force: options.force },
  ).catch((error) => {
    const cached = useAgentDataStore.getState().agents[agentType].catalog.models;
    if (cached.items.length) return cached;
    const fallback = getStaticModelCatalog(agentType);
    if (!fallback.items.length) throw error;
    store.setModelCatalog(agentType, fallback);
    return fallback;
  });
}

/** Start catalog refreshes after runtime discovery without blocking the UI. */
export function prefetchAvailableAgentModels(
  available: Partial<Record<AgentTypeKey, boolean>>,
): void {
  for (const [agentType, isAvailable] of Object.entries(available) as [AgentTypeKey, boolean][]) {
    if (!isAvailable) continue;
    void loadAgentModelCatalog(agentType).catch((error) => {
      logger.warn(`failed to load ${agentType} models`, error);
    });
  }
}

/** Warm project skills for notebook-scoped Agent adapters that need no session. */
export function prefetchNotebookSkills(
  agentType: "codex" | "pi",
  notebookId: string,
  notebookPath: string,
): void {
  void loadNotebookSkillCatalog(agentType, notebookId, notebookPath).catch((error) => {
    logger.warn(`failed to load ${agentType} skills`, error);
  });
}

/** Load a notebook-scoped skill catalog through the shared persistent cache. */
export function loadNotebookSkillCatalog(
  agentType: "codex" | "pi",
  notebookId: string,
  notebookPath: string,
  options: { force?: boolean } = {},
): Promise<AgentCatalogSkill[]> {
  const path = notebookPath.trim();
  if (!path) return Promise.resolve([]);
  const loader = agentType === "codex"
    ? () => listCodexSkillCatalog(path)
    : () => listPiSkills(path);
  return useAgentDataStore.getState().loadSkillCatalog(
    agentType,
    notebookId,
    async () => [...await loader()] as AgentCatalogSkill[],
    { force: options.force },
  );
}

export function invalidateAgentModelCatalog(agentType: AgentTypeKey): void {
  useAgentDataStore.getState().invalidateModelCatalog(agentType);
}

/** Invalidate and immediately refresh a model catalog after its config changes. */
export function refreshAgentModelCatalog(agentType: AgentTypeKey): Promise<AgentModelCatalog> {
  invalidateAgentModelCatalog(agentType);
  return loadAgentModelCatalog(agentType, { force: true });
}

export function invalidateNotebookSkills(agentType: AgentTypeKey, notebookId: string): void {
  useAgentDataStore.getState().invalidateSkillCatalog(agentType, notebookId);
}

async function fetchAgentModelCatalog(agentType: AgentTypeKey): Promise<AgentModelCatalog> {
  if (agentType === "pi") {
    const piCloudAccountId = useAgentDataStore.getState().piCloudAccountId;
    const [providers, models] = await Promise.all([piModels.list(), agent.listSupportedModels("pi")]);
    const defaultProvider = providers.find((provider) => provider.defaultModelId);
    const providerById = new Map(providers.map((provider) => [provider.id, provider]));
    const seen = new Set<string>();
    const items = models.flatMap((model): AgentCatalogModel[] => {
      const separator = model.indexOf("::");
      if (separator < 1) return [];
      const providerId = model.slice(0, separator);
      const id = model.slice(separator + 2);
      const key = `${providerId}\u0000${id}`;
      if (!id || seen.has(key)) return [];
      seen.add(key);
      const provider = providerById.get(providerId);
      if (provider?.source === "flowix-cloud" && !piCloudAccountId) return [];
      const modelConfig = provider?.models.find((entry) => entry.id === id);
      return [{
        id,
        ...(provider ? { source: provider.source === "flowix-cloud" ? "flowix-cloud" as const : "custom" as const } : {}),
        label: modelConfig?.name?.trim() || formatModelDisplayLabel(id),
        ...(modelConfig?.subtitle?.trim() ? { subtitle: modelConfig.subtitle.trim() } : {}),
        ...(modelConfig?.creditMultiplier != null ? { creditMultiplier: modelConfig.creditMultiplier } : {}),
        ...(modelConfig?.sortOrder != null ? { sortOrder: modelConfig.sortOrder } : {}),
        ...(modelConfig?.providerIconUrl || provider?.iconUrl
          ? { iconUrl: modelConfig?.providerIconUrl || provider?.iconUrl }
          : {}),
        providerId,
        providerName: provider?.displayName ?? providerId,
      }];
    });
    const catalog: AgentModelCatalog = {
      // Native provider order is not Cloud-ranked, so unranked (= 0) models
      // keep their original order while ranked Cloud models move to the front.
      items: byModelOrder(items),
      defaultModel: defaultProvider?.defaultModelId ?? "",
      defaultProviderId: defaultProvider?.id,
    };
    // Signed out, the Cloud provider is not installed, so the native list has no
    // Cloud model to offer. The guest overlay keeps that section in the picker,
    // where choosing one asks for a sign-in instead of silently doing nothing.
    return piCloudAccountId ? catalog : withCachedGuestCloudModels(catalog);
  }

  if (agentType === "dsh") {
    const configs = await deepseekHarness.list();
    const preference = useAgentDataStore.getState().agents[agentType].user.model;
    const firstConfig = configs[0]?.model;
    const defaultModel = preference?.id && preference.id !== "inherit"
      ? preference
      : { id: firstConfig?.model.trim() ?? "", providerId: firstConfig?.providerId?.trim() || undefined };
    const seen = new Set<string>();
    const items = configs.flatMap((file): AgentCatalogModel[] => {
      const config = file.model;
      const providerId = config.providerId?.trim() || undefined;
      const providerName = config.displayName?.trim() || config.provider;
      const models = config.models?.length
        ? config.models
        : config.model.trim() ? [{ id: config.model, name: "" }] : [];
      return models
        .map((model) => ({ id: model.id.trim(), label: formatModelDisplayLabel(model.id), providerId, providerName }))
        .filter((model) => model.id.length > 0)
        .filter((model) => {
          const key = `${model.providerId ?? model.providerName}\u0000${model.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    });
    return { items, defaultModel: defaultModel.id, defaultProviderId: defaultModel.providerId };
  }

  if (agentType === "codex") {
    const [catalog, defaultModel] = await Promise.all([
      agent.listCodexModelCatalog(),
      agent.getCodexDefaultModel().catch(() => ""),
    ]);
    const items = catalog.map((model) => ({
        id: model.id,
        label: formatModelDisplayLabel(model.id),
        ...(model.reasoningEfforts?.length
          ? { reasoningEfforts: model.reasoningEfforts.filter((effort): effort is AgentCodexReasoningEffort =>
              SUPPORTED_REASONING_EFFORTS.includes(effort),
            ) }
          : {}),
      }));
    return {
      items: items.length ? items : getStaticModelCatalog("codex").items,
      defaultModel: defaultModel.trim(),
    };
  }

  const models = await agent.listSupportedModels(agentType);
  const items = [...new Set(models.map((model) => model.trim()).filter(Boolean))]
    .map((id) => ({ id, label: formatModelDisplayLabel(id) }));
  return {
    items: items.length ? items : getStaticModelCatalog(agentType).items,
  };
}

function getStaticModelCatalog(agentType: AgentTypeKey): AgentModelCatalog {
  return { items: getFallbackAgentModelOptions(agentType) };
}
