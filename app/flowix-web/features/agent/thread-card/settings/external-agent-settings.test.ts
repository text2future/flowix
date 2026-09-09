// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createCodexSettingsItem } from "./external-agent-settings";

describe("createCodexSettingsItem", () => {
  it("renders a mode name with its secondary description", () => {
    const onSelect = vi.fn();
    const item = createCodexSettingsItem(
      "标准模式",
      true,
      onSelect,
      "功能完整的编码 Agent。",
    );

    expect(item.querySelector(".agent-thread-card__codex-settings-item-label")?.textContent)
      .toBe("标准模式");
    expect(item.querySelector(".agent-thread-card__codex-settings-item-description")?.textContent)
      .toBe("功能完整的编码 Agent。");
    expect(item.getAttribute("aria-checked")).toBe("true");

    item.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders a selected workspace as a non-interactive menu item", () => {
    const onSelect = vi.fn();
    const item = createCodexSettingsItem(
      "开发任务管理",
      true,
      onSelect,
      undefined,
      { readOnly: true },
    ) as HTMLButtonElement;

    expect(item.disabled).toBe(true);
    expect(item.classList.contains("agent-thread-card__codex-settings-item--readonly"))
      .toBe(true);
    expect(item.getAttribute("aria-checked")).toBe("true");
    expect(item.querySelector(".agent-thread-card__copy-icon")).not.toBeNull();

    item.click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("can replace the selected check icon with a text label", () => {
    const item = createCodexSettingsItem(
      "开发任务管理",
      true,
      () => {},
      undefined,
      { readOnly: true, selectedLabel: "cwd" },
    );

    expect(item.querySelector(".agent-thread-card__copy-icon")).toBeNull();
    expect(item.querySelector(".agent-thread-card__codex-settings-item-selected-label")?.textContent)
      .toBe("cwd");
  });
});
