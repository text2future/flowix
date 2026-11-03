import type { AgentCodexModel, AgentTypeKey } from "@/types/agent";
import type { I18nKey } from "@/lib/i18n";
import { POPUP_SEPARATOR_CLASS } from "@shared/ui/popup-separator";
import { createCodexSettingsItem } from "./external-agent-settings";
import {
  createPiModelPicker,
  isFlowixCloudModelOption,
} from "./model-picker/pi-model-picker";
import type { AgentModelOption } from "./model-picker/model-picker-types";

/**
 * 模型选择弹层的内容编排。从 `ExternalAgentSettingsController.renderModelSettings`
 * 抽出——那段纯 DOM 组装占了控制器一百多行, 而控制器本身是状态机, 两者职责不同。
 *
 * 依赖全部经 context 注入, 这样各 agent 类型的列表结构 (分组/空态/推理强度)
 * 可以独立阅读, 不必在 2000 行文件里来回跳。
 */
export interface ModelSettingsListContext {
  typeKey: AgentTypeKey;
  current: AgentCodexModel;
  currentProviderId: string | undefined;
  options: AgentModelOption[];
  loadedOptions: AgentModelOption[];
  piModelsLoadFailed: boolean;
  showEmptyState: boolean;
  supportsReasoning: boolean;
  t: (key: I18nKey) => string;
  createModelItem: (option: AgentModelOption) => HTMLElement;
  onSelectModel: (option: AgentModelOption) => void;
  createSpeedToggle: () => HTMLElement;
  createReasoningSlider: () => HTMLElement;
  renderReasoningOptions: (
    target: HTMLElement,
    useButtonSelectionState?: boolean,
  ) => void;
}

function createModelEmptyItem(
  ctx: ModelSettingsListContext,
): HTMLElement {
  return createCodexSettingsItem(
    ctx.t(
      ctx.piModelsLoadFailed ? "agent.model.loadFailed" : "agent.model.noneFound",
    ),
    false,
    () => {},
    undefined,
    { readOnly: true },
  );
}

function createSectionLabel(
  ctx: ModelSettingsListContext,
  className = "agent-thread-card__codex-settings-section",
): HTMLDivElement {
  const section = document.createElement("div");
  section.className = className;
  section.textContent = ctx.t("agent.model.title");
  return section;
}

function renderCodexModels(
  popover: HTMLElement,
  list: HTMLElement,
  ctx: ModelSettingsListContext,
): void {
  list.classList.add("agent-thread-card__codex-settings-model-list");
  const modelSection = createSectionLabel(
    ctx,
    "agent-thread-card__codex-settings-section agent-thread-card__codex-settings-section--model",
  );
  modelSection.append(ctx.createSpeedToggle());
  list.append(modelSection);

  ctx.options.forEach((option) => {
    list.append(
      createCodexSettingsItem(
        option.label,
        option.id === ctx.current
          && (option.providerId ?? "") === (ctx.currentProviderId ?? ""),
        () => ctx.onSelectModel(option),
      ),
    );
  });
  // Codex 的 reasoning effort 是列表底部一条滑杆, 不随列表滚动。
  popover.append(ctx.createReasoningSlider());
}

function renderPiModels(list: HTMLElement, ctx: ModelSettingsListContext): void {
  list.append(
    createPiModelPicker({
      models: ctx.options,
      showMemberSection: ctx.loadedOptions.some(isFlowixCloudModelOption),
      selectedModelId: ctx.current,
      selectedProviderId: ctx.currentProviderId,
      memberLabel: ctx.t("preferences.pi.cloudTitle"),
      mineLabel: ctx.t("preferences.pi.byokTitle"),
      emptyLabel: ctx.t(
        ctx.piModelsLoadFailed ? "agent.model.loadFailed" : "agent.model.noneFound",
      ),
      personalEmptyLabel: ctx.t("agent.pi.modelSection.mineEmpty"),
      createModelItem: (option) => ctx.createModelItem(option),
    }),
  );
}

function renderProviderGroups(
  list: HTMLElement,
  ctx: ModelSettingsListContext,
): void {
  const groups = new Map<string, { label: string; options: AgentModelOption[] }>();
  ctx.options.forEach((option) => {
    const label = option.providerName?.trim() || option.providerId?.trim() || "Other";
    const key = option.providerId?.trim() || label;
    const group = groups.get(key);
    if (group) {
      group.options.push(option);
    } else {
      groups.set(key, { label, options: [option] });
    }
  });

  groups.forEach((group) => {
    const providerSection = document.createElement("div");
    providerSection.className =
      "agent-thread-card__codex-settings-section agent-thread-card__codex-settings-section--provider";
    providerSection.textContent = group.label;
    list.append(providerSection);
    group.options.forEach((option) => {
      list.append(ctx.createModelItem(option));
    });
  });
}

function renderFlatModels(list: HTMLElement, ctx: ModelSettingsListContext): void {
  list.append(createSectionLabel(ctx));
  if (ctx.showEmptyState) {
    list.append(createModelEmptyItem(ctx));
    return;
  }
  ctx.options.forEach((option) => {
    list.append(ctx.createModelItem(option));
  });
}

function renderReasoningSection(
  list: HTMLElement,
  ctx: ModelSettingsListContext,
): void {
  if (!ctx.supportsReasoning) return;

  const divider = document.createElement("div");
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-hidden", "true");
  divider.className = POPUP_SEPARATOR_CLASS;
  list.append(divider);

  const reasoningSection = createSectionLabel(ctx);
  reasoningSection.textContent = ctx.t("agent.reasoningDepth.title");
  if (ctx.typeKey === "pi") {
    const reasoningGroup = document.createElement("div");
    reasoningGroup.className = "agent-pi-model-picker__reasoning";
    reasoningGroup.setAttribute("role", "group");
    reasoningGroup.setAttribute("aria-label", ctx.t("agent.reasoningDepth.title"));
    reasoningGroup.append(reasoningSection);
    list.append(reasoningGroup);
    ctx.renderReasoningOptions(reasoningGroup, true);
    return;
  }
  list.append(reasoningSection);
  ctx.renderReasoningOptions(list);
}

export function renderModelSettingsBody(
  popover: HTMLElement,
  list: HTMLElement,
  ctx: ModelSettingsListContext,
): void {
  if (ctx.typeKey === "codex") {
    renderCodexModels(popover, list, ctx);
    return;
  }
  if (ctx.typeKey === "pi") {
    renderPiModels(list, ctx);
  } else if (ctx.typeKey === "dsh") {
    if (ctx.showEmptyState) {
      list.append(createSectionLabel(ctx));
      list.append(createModelEmptyItem(ctx));
    } else {
      renderProviderGroups(list, ctx);
    }
  } else {
    renderFlatModels(list, ctx);
  }
  renderReasoningSection(list, ctx);
}
