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
  tags?: string[];
  creditMultiplier?: number;
  recommended?: boolean;
  reasoningConfig?: { levels: string[]; defaultLevel?: string | null };
  iconUrl?: string;
  reasoningEfforts?: AgentCodexReasoningEffort[];
  /** DeepSeek Harness llm-pi-ai route; absent for legacy/Codex options. */
  providerId?: string;
  providerName?: string;
};
