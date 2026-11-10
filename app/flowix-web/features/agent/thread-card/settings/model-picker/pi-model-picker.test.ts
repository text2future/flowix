import { describe, expect, it } from "vitest";
import type { AgentModelOption } from "./model-picker-types";
import { createPiModelPicker } from "./pi-model-picker";

function createModelItem(model: AgentModelOption): HTMLElement {
  const item = document.createElement("button");
  const icon = document.createElement("img");
  icon.className = "agent-thread-card__model-provider-icon";
  icon.src = model.iconUrl ?? "";
  icon.alt = "";
  const label = document.createElement("span");
  label.className = "agent-thread-card__codex-settings-item-label";
  label.textContent = model.label;
  item.append(icon, label);
  if (model.id === "deepseek-v3.2") {
    const checkmark = document.createElement("span");
    checkmark.className = "agent-thread-card__copy-icon";
    item.append(checkmark);
  }
  return item;
}

describe("Pi model picker provider icons", () => {
  it("shows member and personal models in stacked sections", () => {
    const picker = createPiModelPicker({
      models: [
        {
          id: "member-model",
          label: "Member model",
          providerId: "flowix-cloud-member",
          providerName: "Flowix Cloud",
        },
        {
          id: "custom-model",
          label: "Custom model",
          providerId: "custom-provider",
          providerName: "My provider",
        },
      ],
      showMemberSection: true,
      selectedModelId: "custom-model",
      selectedProviderId: "custom-provider",
      memberLabel: "会员模型",
      mineLabel: "我的模型",
      emptyLabel: "没有模型",
      personalEmptyLabel: "还没有自定义模型",
      onAddCustomModel: () => {},
      createModelItem,
    });

    const categories = picker.querySelectorAll(".agent-pi-model-picker__category");
    expect(Array.from(categories).map((category) =>
      category.querySelector(".agent-pi-model-picker__category-label")?.textContent,
    )).toEqual(["我的模型"]);
    expect(picker.querySelector(".agent-pi-model-picker__item")?.textContent)
      .toContain("Member model");
    expect(categories[0]?.querySelector(".agent-pi-model-picker__item")?.textContent)
      .toContain("Custom model");
  });

  it("uses the personal model item layout when the member section is hidden", () => {
    const picker = createPiModelPicker({
      models: [
        {
          id: "custom-model",
          label: "custom-model",
          iconUrl: "https://example.com/provider-icons/custom.png",
          providerId: "custom-provider",
          providerName: "My provider",
        },
      ],
      showMemberSection: false,
      selectedModelId: "custom-model",
      selectedProviderId: "custom-provider",
      memberLabel: "会员模型",
      mineLabel: "我的模型",
      emptyLabel: "没有模型",
      personalEmptyLabel: "还没有自定义模型",
      onAddCustomModel: () => {},
      createModelItem,
    });

    const item = picker.querySelector<HTMLButtonElement>(".agent-pi-model-picker__item");
    const providerName = item?.querySelector(".agent-pi-model-picker__provider-name");
    expect(picker.querySelector(".agent-pi-model-picker__category-label")).toBeNull();
    expect(picker.querySelector(".agent-pi-model-picker__panel > .agent-pi-model-picker__models"))
      .not.toBeNull();
    expect(picker.querySelector(".agent-pi-model-picker__provider-label")).toBeNull();
    expect(item?.querySelector(".agent-pi-model-picker__provider-icon")).not.toBeNull();
    expect(providerName?.textContent).toBe("My provider");
    const checkmarkPlaceholder = item?.querySelector(
      ".agent-pi-model-picker__checkmark-placeholder",
    );
    expect(checkmarkPlaceholder?.getAttribute("aria-hidden")).toBe("true");
    expect(providerName?.nextElementSibling).toBe(checkmarkPlaceholder);
  });

  it("shows the provider icon before the model key in both stacked sections", () => {
    const picker = createPiModelPicker({
      models: [
        {
          id: "deepseek-v3.2",
          label: "deepseek-v3.2",
          subtitle: "稳定高速模型",
          creditMultiplier: 1.25,
          iconUrl: "https://staging-cloud.flowix.cc/provider-icons/deepseek.png",
          providerId: "flowix-cloud-member",
          providerName: "Flowix Cloud",
        },
        {
          id: "custom-model",
          label: "custom-model",
          iconUrl: "https://example.com/provider-icons/custom.png",
          providerId: "custom-provider",
          providerName: "My provider",
        },
      ],
      showMemberSection: true,
      selectedModelId: "deepseek-v3.2",
      selectedProviderId: "flowix-cloud-member",
      memberLabel: "会员模型",
      mineLabel: "我的模型",
      emptyLabel: "没有模型",
      personalEmptyLabel: "还没有自定义模型",
      onAddCustomModel: () => {},
      createModelItem,
    });

    const categories = picker.querySelectorAll(".agent-pi-model-picker__category");
    const memberItem = picker.querySelector<HTMLButtonElement>(".agent-pi-model-picker__item");
    expect(memberItem?.title).toBe("稳定高速模型");
    const memberIcon = memberItem?.querySelector(".agent-pi-model-picker__provider-icon");
    expect(memberIcon).not.toBeNull();
    expect(memberItem?.firstElementChild).toBe(memberIcon);
    expect(memberItem?.querySelector(".agent-thread-card__codex-settings-item-label")?.textContent)
      .toBe("deepseek-v3.2");
    const multiplier = memberItem?.querySelector(".agent-pi-model-picker__multiplier");
    const checkmark = memberItem?.querySelector(".agent-thread-card__copy-icon");
    expect(multiplier?.textContent).toBe("1.25x");
    expect(multiplier?.nextElementSibling).toBe(checkmark);

    const personalItem = categories[0]?.querySelector<HTMLButtonElement>(".agent-pi-model-picker__item");
    const personalIcon = personalItem?.querySelector(".agent-pi-model-picker__provider-icon");
    expect(personalIcon).not.toBeNull();
    expect(personalItem?.firstElementChild).toBe(personalIcon);
    expect(personalItem?.querySelector(".agent-thread-card__codex-settings-item-label")?.textContent)
      .toBe("custom-model");
    const providerName = personalItem?.querySelector(".agent-pi-model-picker__provider-name");
    expect(providerName?.textContent).toBe("My provider");
    expect(providerName?.nextElementSibling?.classList.contains(
      "agent-pi-model-picker__checkmark-placeholder",
    )).toBe(true);
    expect(picker.querySelector(".agent-pi-model-picker__provider-label")).toBeNull();
  });
});
