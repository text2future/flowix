import type { AgentHarnessPreset, AgentTypeKey, RuntimeConfig } from "@/types/agent";
import { isFlowixCloudModel } from "@features/agent/config/agent-model-source";
import { FLOWIX_CLOUD_PREVIEW_PROVIDER_ID } from "@features/agent/config/cloud-access";
import { modelPreferenceKey, useAgentDataStore } from "./agent-data-store";

/**
 * Apply this Agent's remembered preferences, preserving conversation overrides.
 *
 * Pi is the exception: its model lives in the shared preference, like `mode`.
 * A per-conversation snapshot would outrank a later pick whenever the picker
 * could not reach the instance (a card whose node attribute has no id yet), so
 * the selection looked applied and the next run still used the old model.
 */
export function resolveAgentPreferenceRuntimeConfig(
  agentType: AgentTypeKey,
  runtimeConfig: RuntimeConfig = {},
): RuntimeConfig {
  const agent = useAgentDataStore.getState().agents[agentType];
  const preference = agent.user;
  const savedModel = preference.model;
  const memberModel = agentType === "pi"
    && savedModel?.providerId === FLOWIX_CLOUD_PREVIEW_PROVIDER_ID
    ? agent.catalog.models.items.find((item) =>
        item.id === savedModel.id
        && isFlowixCloudModel(item)
        && item.providerId !== FLOWIX_CLOUD_PREVIEW_PROVIDER_ID,
      )
    : undefined;
  const effectiveProviderId = memberModel?.providerId ?? savedModel?.providerId;
  const preferenceModel = savedModel
    ? {
        key: savedModel.id,
        ...(effectiveProviderId ? { providerId: effectiveProviderId } : {}),
      }
    : undefined;
  const model = agentType === "pi"
    ? preferenceModel ?? runtimeConfig.model
    : runtimeConfig.model ?? preferenceModel;
  const modelReasoning = model
    ? preference.reasoningByModel?.[modelPreferenceKey({ id: model.key, providerId: model.providerId })]
    : undefined;
  const supportedEfforts = model
    ? agent.catalog.models.items.find((item) => item.id === model.key && item.providerId === model.providerId)?.reasoningEfforts
    : undefined;
  const defaultEffort = supportedEfforts?.includes("medium") ? "medium" : supportedEfforts?.[0];
  const reasoningEffort = runtimeConfig.reasoningEffort ?? modelReasoning
    ?? (!model ? preference.reasoningEffort : defaultEffort);
  const permission = runtimeConfig.access?.sandbox ?? preference.permission;
  const serviceTier = runtimeConfig.serviceTier ?? preference.serviceTier;
  const harnessMode = runtimeConfig.deepseekHarness?.mode ?? preference.mode;
  // Historical Pi mode snapshots are ignored; Pi mode is shared across conversations.
  const { pi: _legacyPiMode, ...conversationConfig } = runtimeConfig;
  return {
    ...conversationConfig,
    ...(model ? { model } : {}),
    ...(permission ? { access: { ...runtimeConfig.access, sandbox: permission } } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(harnessMode && agentType === "dsh"
      ? { deepseekHarness: { ...runtimeConfig.deepseekHarness, mode: harnessMode as AgentHarnessPreset } }
      : {}),
  };
}
