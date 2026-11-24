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
  onAddCustomModel: () => void;
  createModelItem: (model: AgentModelOption) => HTMLElement;
  onSelectReasoning?: (model: AgentModelOption, level: string) => void;
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

function createDetails(model: AgentModelOption, props: PiModelPickerProps): HTMLElement {
  const item = document.createElement("div");
  item.className = "agent-pi-model-picker__details";
  const title = document.createElement("strong");
  title.textContent = model.label;
  item.append(title);
  const description = model.description?.trim() || model.subtitle?.trim();
  const text = document.createElement("span");
  text.textContent = description || "暂无模型描述";
  item.append(text);
  if (model.creditMultiplier != null) {
    const rate = document.createElement("span");
    rate.textContent = `消耗倍率：${model.creditMultiplier.toFixed(2)}x`;
    item.append(rate);
  }
  if (model.reasoningConfig) {
    const label = document.createElement("label");
    label.textContent = "思考强度 ";
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${model.label} 思考强度`);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = model.reasoningConfig.defaultLevel
      ? `默认 (${model.reasoningConfig.defaultLevel})` : "服务商默认";
    placeholder.selected = true;
    placeholder.disabled = true;
    select.append(placeholder);
    for (const level of model.reasoningConfig.levels) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      select.append(option);
    }
    select.addEventListener("change", () => props.onSelectReasoning?.(model, select.value));
    label.append(select);
    item.append(label);
  } else {
    const unavailable = document.createElement("span");
    unavailable.textContent = "思考强度：未配置";
    item.append(unavailable);
  }
  return item;
}

function attachModelDetails(wrapper: HTMLElement, model: AgentModelOption, props: PiModelPickerProps): void {
  const doc = wrapper.ownerDocument;
  let details: HTMLElement | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  const close = () => {
    if (closeTimer) clearTimeout(closeTimer);
    details?.remove();
    details = null;
    observer?.disconnect();
    observer = undefined;
    doc.removeEventListener("scroll", close, true);
    doc.defaultView?.removeEventListener("resize", close);
  };
  const scheduleClose = () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(close, 180);
  };
  const show = () => {
    if (closeTimer) clearTimeout(closeTimer);
    if (details) return;
    // Only one secondary popup may be visible, even while a previous row's
    // short pointer-crossing grace period is pending.
    doc.querySelectorAll<HTMLElement>(".agent-pi-model-picker__details").forEach((popup) => popup.dispatchEvent(new Event("pi-details-close")));
    details = createDetails(model, props);
    details.addEventListener("pi-details-close", close, { once: true });
    details.setAttribute("role", "group");
    details.setAttribute("aria-label", `${model.label} 详情`);
    details.addEventListener("mouseenter", () => { if (closeTimer) clearTimeout(closeTimer); });
    details.addEventListener("mouseleave", scheduleClose);
    details.addEventListener("focusin", () => { if (closeTimer) clearTimeout(closeTimer); });
    details.addEventListener("focusout", (event) => {
      if (!details?.contains(event.relatedTarget as Node | null)) scheduleClose();
    });
    doc.body.append(details);
    const rect = wrapper.getBoundingClientRect();
    const width = details.offsetWidth || 240;
    const height = details.offsetHeight || 120;
    const viewportWidth = doc.defaultView?.innerWidth ?? 1024;
    const viewportHeight = doc.defaultView?.innerHeight ?? 768;
    const left = rect.right + width <= viewportWidth ? rect.right : rect.left - width;
    details.style.left = `${Math.max(8, Math.min(left, viewportWidth - width - 8))}px`;
    details.style.top = `${Math.max(8, Math.min(rect.top, viewportHeight - height - 8))}px`;
    doc.addEventListener("scroll", close, true);
    doc.defaultView?.addEventListener("resize", close);
    observer = new MutationObserver(() => { if (!wrapper.isConnected) close(); });
    observer.observe(doc.body, { childList: true, subtree: true });
  };
  wrapper.addEventListener("mouseenter", show);
  wrapper.addEventListener("mouseleave", scheduleClose);
  wrapper.addEventListener("focusin", show);
  wrapper.addEventListener("focusout", (event) => {
    const target = event.relatedTarget as Node | null;
    if (!wrapper.contains(target) && !details?.contains(target)) scheduleClose();
  });
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
      if (subtitle) item.setAttribute("aria-description", subtitle);
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
      const wrapper = document.createElement("div");
      wrapper.className = "agent-pi-model-picker__item-wrapper";
      wrapper.append(item);
      if (isFlowixCloudModelOption(model)) attachModelDetails(wrapper, model, props);
      groupElement.append(wrapper);
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

  if (models.length > 0) {
    const heading = document.createElement("div");
    heading.className = "agent-thread-card__codex-settings-title agent-pi-model-picker__category-label";
    heading.setAttribute("role", "heading");
    heading.setAttribute("aria-level", "3");
    heading.textContent = label;
    category.append(heading);
    category.append(createModelGroups(models, props, providerLabelPlacement));
  } else if (emptyLabel) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.className = "agent-pi-model-picker__empty agent-pi-model-picker__empty--category";
    empty.textContent = emptyLabel;
    empty.addEventListener("click", props.onAddCustomModel);
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
