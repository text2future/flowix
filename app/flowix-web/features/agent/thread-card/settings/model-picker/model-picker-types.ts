import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
} from "@/types/agent";

export type AgentModelOption = {
  source?: "flowix-cloud" | "custom";
  id: AgentCodexModel;
  label: string;
  description?: string;
  subtitle?: string;
  creditMultiplier?: number;
  reasoningConfig?: { levels: string[]; defaultLevel?: string | null };
  iconUrl?: string;
  reasoningEfforts?: AgentCodexReasoningEffort[];
  /** DeepSeek Harness llm-pi-ai route; absent for legacy/Codex options. */
  providerId?: string;
  providerName?: string;
};
