import type { AgentModelOption } from "./model-picker-types";
import { isFlowixCloudModel } from "@features/agent/config/agent-model-source";

type PiModelPickerProps = {
  models: readonly AgentModelOption[];
  showMemberSection: boolean;
  selectedModelId: string;
  selectedProviderId?: string;
  memberLabel: string;
  mineLabel: string;
  emptyLabel: string;
  personalEmptyLabel: string;
  createModelItem: (model: AgentModelOption) => HTMLElement;
};

type ProviderLabelPlacement = "group" | "item" | "none";

export function isFlowixCloudModelOption(model: AgentModelOption): boolean {
  return isFlowixCloudModel(model);
}

function groupModels(models: readonly AgentModelOption[]) {
  const groups = new Map<string, { label: string; models: AgentModelOption[] }>();
  models.forEach((model) => {
    const label = providerLabel(model);
    const key = model.providerId?.trim() || label;
    const group = groups.get(key);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(key, { label, models: [model] });
    }
  });
  return [...groups.values()];
}

function providerLabel(model: AgentModelOption): string {
  return model.providerName?.trim() || model.providerId?.trim() || "Other";
}

function createModelGroups(
  models: readonly AgentModelOption[],
  props: PiModelPickerProps,
  providerLabelPlacement: ProviderLabelPlacement,
): HTMLElement {
  const list = document.createElement("div");
  list.className = "agent-pi-model-picker__models";

  groupModels(models).forEach((group) => {
    const groupElement = document.createElement("section");
    groupElement.className = "agent-pi-model-picker__provider";
    groupElement.setAttribute("role", "group");
    groupElement.setAttribute("aria-label", group.label);

    if (providerLabelPlacement === "group") {
      const heading = document.createElement("div");
      heading.className = "agent-pi-model-picker__provider-label";
      heading.textContent = group.label;
      groupElement.append(heading);
    }

    group.models.forEach((model) => {
      const item = props.createModelItem(model);
      item.classList.add("agent-pi-model-picker__item");
      const subtitle = isFlowixCloudModelOption(model) ? model.subtitle?.trim() : undefined;
      if (subtitle) item.title = subtitle;
      const checkmark = item.querySelector(".agent-thread-card__copy-icon");
      if (providerLabelPlacement === "item") {
        const providerName = document.createElement("span");
        providerName.className = "agent-pi-model-picker__provider-name";
        providerName.textContent = group.label;
        providerName.title = group.label;
        item.insertBefore(providerName, checkmark);
      }
      if (isFlowixCloudModelOption(model) && model.creditMultiplier != null) {
        const multiplier = document.createElement("span");
        multiplier.className = "agent-pi-model-picker__multiplier";
        multiplier.textContent = `${model.creditMultiplier.toFixed(2)}x`;
        multiplier.setAttribute(
          "aria-label",
          `credit multiplier ${model.creditMultiplier.toFixed(2)}`,
        );
        item.insertBefore(multiplier, checkmark);
      }
      if (!checkmark) {
        const checkmarkPlaceholder = document.createElement("span");
        checkmarkPlaceholder.className = "agent-pi-model-picker__checkmark-placeholder";
        checkmarkPlaceholder.setAttribute("aria-hidden", "true");
        item.append(checkmarkPlaceholder);
      }
      const providerIcon = item.querySelector(".agent-thread-card__model-provider-icon");
      if (providerIcon) {
        providerIcon.classList.add("agent-pi-model-picker__provider-icon");
        item.prepend(providerIcon);
      }
      item.removeAttribute("role");
      item.removeAttribute("aria-checked");
      item.setAttribute(
        "aria-pressed",
        model.id === props.selectedModelId
          && (model.providerId ?? "") === (props.selectedProviderId ?? "")
          ? "true"
          : "false",
      );
      groupElement.append(item);
    });
    list.append(groupElement);
  });
  return list;
}

function createModelCategory(
  label: string,
  models: readonly AgentModelOption[],
  props: PiModelPickerProps,
  providerLabelPlacement: ProviderLabelPlacement,
  emptyLabel?: string,
): HTMLElement {
  const category = document.createElement("section");
  category.className = "agent-pi-model-picker__category";

  const heading = document.createElement("div");
  heading.className = "agent-thread-card__codex-settings-title agent-pi-model-picker__category-label";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "3");
  heading.textContent = label;
  category.append(heading);

  if (models.length > 0) {
    category.append(createModelGroups(models, props, providerLabelPlacement));
  } else if (emptyLabel) {
    const empty = document.createElement("div");
    empty.className = "agent-pi-model-picker__empty agent-pi-model-picker__empty--category";
    empty.textContent = emptyLabel;
    category.append(empty);
  }

  return category;
}

export function createPiModelPicker(props: PiModelPickerProps): HTMLElement {
  const root = document.createElement("div");
  root.className = "agent-pi-model-picker";

  if (props.models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "agent-pi-model-picker__empty";
    empty.textContent = props.emptyLabel;
    root.append(empty);
    return root;
  }

  const memberModels = props.models.filter(isFlowixCloudModelOption);
  const mineModels = props.models.filter((model) => !isFlowixCloudModelOption(model));
  if (!props.showMemberSection || memberModels.length === 0) {
    const panel = document.createElement("div");
    panel.className = "agent-pi-model-picker__panel";
    panel.append(createModelGroups(props.models, props, "item"));
    root.append(panel);
    return root;
  }

  const panel = document.createElement("div");
  panel.className = "agent-pi-model-picker__panel";
  panel.append(
    createModelGroups(memberModels, props, "none"),
    createModelCategory(
      props.mineLabel,
      mineModels,
      props,
      "item",
      props.personalEmptyLabel,
    ),
  );
  const customSection = panel.lastElementChild as HTMLElement;
  customSection.classList.add("agent-pi-model-picker__category--custom");
  root.append(panel);
  return root;
}
