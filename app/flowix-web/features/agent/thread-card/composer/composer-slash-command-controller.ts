import type { Editor } from "@tiptap/core";
import {
  getComposerSlashToken,
  insertComposerSlashToken,
  removeComposerSlashToken,
} from "@features/agent/thread-card/composer/composer-slash-token";
import {
  displayNameForComposerSkill,
  insertComposerSkillToken,
} from "@features/agent/thread-card/composer/composer-skill-token";
import type { AgentTypeKey } from "@/types/agent";

export interface ComposerSlashCommand {
  name: string;
  description: string;
  /** Agent-owned commands are only offered by that agent's composer. */
  agentType?: AgentTypeKey;
  /** Owner is explicit so another agent's same-named slash item is not reused. */
  owner?: "dsh" | "flowix";
  /** How selection continues: execute now, add a prompt token, or drill down. */
  interaction?: "direct" | "prompt" | "drilldown";
  /** Execution authority behind the selected item. */
  execution?: "dsh-command" | "dsh-skill" | "codex-command" | "codex-skill" | "host-action";
}

export const COMPOSER_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  { name: "compact", description: "压缩较早的对话上下文", agentType: "deepseek-harness", owner: "dsh", interaction: "direct", execution: "dsh-command" },
  { name: "skill", description: "选择一个 DSH Skill", agentType: "deepseek-harness", owner: "dsh", interaction: "drilldown", execution: "dsh-skill" },
  { name: "goal", description: "设置或查看长时任务目标", agentType: "deepseek-harness", owner: "dsh", interaction: "prompt", execution: "dsh-command" },
  { name: "plan", description: "进入或退出计划模式", agentType: "deepseek-harness", owner: "dsh", interaction: "prompt", execution: "dsh-command" },
  { name: "model", description: "选择本次会话使用的模型", agentType: "deepseek-harness", owner: "flowix", interaction: "drilldown", execution: "host-action" },
  { name: "permission", description: "切换权限预设", agentType: "deepseek-harness", owner: "flowix", interaction: "drilldown", execution: "host-action" },
  { name: "export", description: "导出当前 DSH 会话记录", agentType: "deepseek-harness", owner: "dsh", interaction: "direct", execution: "dsh-command" },
  { name: "compact", description: "压缩较早的 Codex 对话上下文", agentType: "codex", owner: "flowix", interaction: "direct", execution: "codex-command" },
  { name: "skill", description: "选择一个 Codex Skill", agentType: "codex", owner: "flowix", interaction: "drilldown", execution: "codex-skill" },
  { name: "goal", description: "设置或查看 Codex 长时任务目标", agentType: "codex", owner: "flowix", interaction: "prompt", execution: "codex-command" },
  { name: "model", description: "选择本次会话使用的模型", agentType: "codex", owner: "flowix", interaction: "drilldown", execution: "host-action" },
  { name: "permission", description: "切换权限预设", agentType: "codex", owner: "flowix", interaction: "drilldown", execution: "host-action" },
];

export interface ComposerSlashSkill {
  name: string;
  description: string;
  displayName?: string;
  shortDescription?: string;
  whenToUse?: string;
  modelInvocable?: boolean;
}

export { formatCodexSkillDisplayName } from "@features/agent/thread-card/composer/composer-skill-token";

export interface ComposerSlashCommandControllerOptions {
  editor: Editor;
  input: HTMLDivElement;
  composer: HTMLElement;
  commands?: readonly ComposerSlashCommand[];
  agentType?: AgentTypeKey;
  listDshSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  listCodexSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  onModelSelect?: () => void;
  onPermissionSelect?: () => void;
  onDirectCommand?: (command: ComposerSlashCommand) => void;
  onCommandChange?: () => void;
  focusInput?: () => void;
}

/**
 * Slash picker for the small composer editor.
 *
 * The picker owns only presentation and selection. A selected token remains a
 * real prompt value and is expanded back to `/command` by ComposerController;
 * direct DSH commands are handed to the host through onDirectCommand.
 */
export class ComposerSlashCommandController {
  private readonly editor: Editor;
  private readonly input: HTMLDivElement;
  private readonly composer: HTMLElement;
  private readonly commands: readonly ComposerSlashCommand[];
  private readonly agentType: AgentTypeKey | undefined;
  private readonly listDshSkills: (() => Promise<readonly ComposerSlashSkill[]>) | undefined;
  private readonly listCodexSkills: (() => Promise<readonly ComposerSlashSkill[]>) | undefined;
  private readonly onModelSelect: (() => void) | undefined;
  private readonly onPermissionSelect: (() => void) | undefined;
  private readonly onDirectCommand: ((command: ComposerSlashCommand) => void) | undefined;
  private readonly onCommandChange: () => void;
  private readonly focusInput: () => void;
  private readonly inputRow: HTMLDivElement;
  private menu: HTMLDivElement | null = null;
  private filtered: readonly ComposerSlashCommand[] = [];
  private skills: readonly ComposerSlashSkill[] = [];
  private menuMode: "commands" | "skills" = "commands";
  private skillsLoading = false;
  private skillsRequestGeneration = 0;
  private activeIndex = 0;
  private isKeyboardNavigation = true;
  private dismissedValue: string | null = null;
  private disposed = false;

  constructor(options: ComposerSlashCommandControllerOptions) {
    this.editor = options.editor;
    this.input = options.input;
    this.composer = options.composer;
    this.commands = options.commands ?? COMPOSER_SLASH_COMMANDS;
    this.agentType = options.agentType;
    this.listDshSkills = options.listDshSkills;
    this.listCodexSkills = options.listCodexSkills;
    this.onModelSelect = options.onModelSelect;
    this.onPermissionSelect = options.onPermissionSelect;
    this.onDirectCommand = options.onDirectCommand;
    this.onCommandChange = options.onCommandChange ?? (() => undefined);
    this.focusInput = options.focusInput ?? (() => {
      this.editor.commands.focus(null, { scrollIntoView: false });
      this.editor.view.focus();
    });

    this.inputRow = document.createElement("div");
    this.inputRow.className = "agent-thread-card__composer-input-row";
    this.input.before(this.inputRow);
    this.inputRow.append(this.input);

    this.input.addEventListener("keydown", this.handleKeydown, true);
    // The row is the actual expanded/fullscreen grid item. It has clickable
    // padding around the editor (and around a selected slash token), so do
    // not rely on the browser's default focus behavior for the row itself.
    // Tauri WebViews can deliver a mouse event without a usable pointer event;
    // keep all three paths on the same Tiptap-aware focus callback.
    this.inputRow.addEventListener("pointerdown", this.handleInputRowPointerDown);
    this.inputRow.addEventListener("mousedown", this.handleInputRowMouseDown);
    this.inputRow.addEventListener("click", this.handleInputRowClick);
    this.editor.on("update", this.handleEditorUpdate);
    this.editor.on("selectionUpdate", this.handleSelectionUpdate);
    document.addEventListener("pointerdown", this.handleOutsidePointerDown, true);
    window.addEventListener("resize", this.updateMenuPosition);
    window.addEventListener("scroll", this.updateMenuPosition, true);
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.removeEventListener("keydown", this.handleKeydown, true);
    this.inputRow.removeEventListener("pointerdown", this.handleInputRowPointerDown);
    this.inputRow.removeEventListener("mousedown", this.handleInputRowMouseDown);
    this.inputRow.removeEventListener("click", this.handleInputRowClick);
    this.editor.off("update", this.handleEditorUpdate);
    this.editor.off("selectionUpdate", this.handleSelectionUpdate);
    document.removeEventListener("pointerdown", this.handleOutsidePointerDown, true);
    window.removeEventListener("resize", this.updateMenuPosition);
    window.removeEventListener("scroll", this.updateMenuPosition, true);
    this.closeMenu();
    removeComposerSlashToken(this.editor);
    if (this.inputRow.isConnected) {
      this.inputRow.before(this.input);
      this.inputRow.remove();
    }
  }

  refresh(): void {
    // Keep the agent scope at the controller boundary so unscoped/custom
    // descriptors cannot accidentally make a command available to another
    // Agent.
    if (this.disposed || !this.agentType || getComposerSlashToken(this.editor)) {
      this.closeMenu();
      return;
    }

    // Skill selection is a second-level menu. Keep it open while the editor
    // is temporarily empty; otherwise the editor update caused by clearing
    // `/skill` would immediately tear down the submenu.
    if (this.menuMode === "skills") return;

    const { selection, doc } = this.editor.state;
    const value = this.editor.getMarkdown().trim();
    const cursorAtEnd = selection.empty && selection.from === doc.content.size - 1;
    const match = cursorAtEnd ? /^\/([a-z]*)$/i.exec(value) : null;
    if (!match || value === this.dismissedValue) {
      this.closeMenu();
      return;
    }

    const query = match[1].toLowerCase();
    this.filtered = this.commands
      .filter((command) => !command.agentType || command.agentType === this.agentType)
      .filter((command) => command.name.toLowerCase().includes(query));
    if (this.filtered.length === 0) {
      this.closeMenu();
      return;
    }
    this.activeIndex = 0;
    this.isKeyboardNavigation = true;
    this.openMenu();
  }

  private readonly handleEditorUpdate = (): void => {
    this.dismissedValue = null;
    this.refresh();
  };

  private readonly handleInputRowPointerDown = (event: PointerEvent): void => {
    this.focusInputRow(event);
  };

  private readonly handleInputRowMouseDown = (event: MouseEvent): void => {
    this.focusInputRow(event);
  };

  private readonly handleInputRowClick = (event: MouseEvent): void => {
    this.focusInputRow(event);
  };

  private focusInputRow(event: MouseEvent): void {
    if (this.disposed || event.button !== 0) return;
    if (this.editor.isDestroyed || this.editor.view.hasFocus()) return;

    const target = event.target instanceof Element ? event.target : null;
    // Preserve normal caret placement/text selection inside the editor and
    // keep the slash command token (a real button) clickable/removable.
    if (
      target &&
      (
        this.input.contains(target) ||
        target.closest(
          "button, a[href], [role='button'], [data-no-composer-focus]",
        )
      )
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.focusInput();
  }

  private readonly handleSelectionUpdate = (): void => {
    this.refresh();
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return;

    if (this.menu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const count = this.menuMode === "commands" ? this.filtered.length : this.skills.length;
        if (count === 0) return;
        this.activeIndex = (this.activeIndex + direction + count) % count;
        this.isKeyboardNavigation = true;
        this.renderMenuItems();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.menuMode === "commands") {
          const command = this.filtered[this.activeIndex];
          if (command) this.select(command);
        } else {
          const skill = this.skills[this.activeIndex];
          if (skill) this.selectSkill(skill);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.dismissedValue = this.editor.getMarkdown().trim();
        this.menuMode = "commands";
        this.closeMenu();
        return;
      }
    }

    if (
      getComposerSlashToken(this.editor) &&
      event.key === "Backspace" &&
      this.editor.state.selection.empty &&
      this.editor.state.selection.from === 1
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.removeSelectedToken();
    }
  };

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    if (!this.menu) return;
    const target = event.target as Node | null;
    if (target && (this.composer.contains(target) || this.menu.contains(target))) return;
    this.dismissedValue = this.editor.getMarkdown().trim();
    this.closeMenu();
  };

  private openMenu(): void {
    if (!this.menu) {
      this.menu = document.createElement("div");
      this.menu.className = "agent-composer-slash-menu";
      this.menu.setAttribute("role", "listbox");
      this.menu.setAttribute("aria-label", "Slash commands");
      document.body.append(this.menu);
    }
    this.renderMenuItems();
    this.updateMenuPosition();
  }

  private renderMenuItems(): void {
    const menu = this.menu;
    if (!menu) return;
    menu.classList.toggle("is-keyboard-navigation", this.isKeyboardNavigation);
    menu.replaceChildren();

    if (this.menuMode === "skills") {
      this.renderSkillsMenu(menu);
      return;
    }

    this.filtered.forEach((command, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-composer-slash-menu__item";
      item.classList.toggle("agent-composer-slash-menu__item--active", index === this.activeIndex);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.activeIndex));
      const name = document.createElement("span");
      name.className = "agent-composer-slash-menu__name";
      name.textContent = `/${command.name}`;
      const description = document.createElement("span");
      description.className = "agent-composer-slash-menu__description";
      description.textContent = command.description;
      item.append(name, description);
      item.addEventListener("mousemove", (event) => this.handleItemMouseMove(event, index));
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => this.select(command));
      menu.append(item);
    });
    const activeItem = menu.children[this.activeIndex] as HTMLElement | undefined;
    activeItem?.scrollIntoView?.({ block: "nearest" });
  }

  private readonly updateMenuPosition = (): void => {
    if (!this.menu || !this.composer.isConnected) return;
    const rect = this.composer.getBoundingClientRect();
    const viewportPadding = 8;
    const menuGap = 4;
    const width = Math.max(240, Math.min(rect.width, window.innerWidth - viewportPadding * 2));
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      window.innerWidth - width - viewportPadding,
    );
    this.menu.style.width = `${width}px`;
    this.menu.style.left = `${left}px`;
    this.menu.style.bottom = `${Math.max(viewportPadding, window.innerHeight - rect.top + menuGap)}px`;
  };

  private handleItemMouseMove(event: MouseEvent, index: number): void {
    // Match the editor slash menu: after keyboard navigation, browsers may
    // report a zero-distance mouse move while the pointer is still over the
    // newly rendered item. That must not steal the selection.
    if (event.movementX === 0 && event.movementY === 0) return;
    if (this.activeIndex === index && !this.isKeyboardNavigation) return;
    this.activeIndex = index;
    this.isKeyboardNavigation = false;
    this.renderMenuItems();
  }

  private select(command: ComposerSlashCommand): void {
    if (command.execution === "dsh-skill" || command.execution === "codex-skill") {
      void this.openSkills();
      return;
    }

    this.closeMenu();
    this.menuMode = "commands";
    if (command.name === "model" && command.execution === "host-action") {
      this.clearInput();
      this.onModelSelect?.();
      return;
    }
    if (command.name === "permission" && command.execution === "host-action") {
      this.clearInput();
      this.onPermissionSelect?.();
      return;
    }
    if (command.interaction === "direct") {
      this.clearInput();
      this.onDirectCommand?.(command);
      return;
    }
    insertComposerSlashToken(this.editor, command.name, command.agentType);
    this.onCommandChange();
  }

  private clearInput(): void {
    this.editor.commands.setContent("", {
      contentType: "markdown",
      emitUpdate: false,
    });
    this.editor.commands.focus(null, { scrollIntoView: false });
    this.onCommandChange();
  }

  private async openSkills(): Promise<void> {
    this.menuMode = "skills";
    this.skills = [];
    this.activeIndex = 0;
    this.isKeyboardNavigation = true;
    this.skillsLoading = true;
    const generation = ++this.skillsRequestGeneration;
    this.editor.commands.setContent("", { contentType: "markdown", emitUpdate: false });
    this.openMenu();
    this.focusInput();

    try {
      const listSkills = this.agentType === "codex" ? this.listCodexSkills : this.listDshSkills;
      const skills = await listSkills?.() ?? [];
      if (this.disposed || generation !== this.skillsRequestGeneration) return;
      this.skills = skills;
    } catch (error) {
      if (this.disposed || generation !== this.skillsRequestGeneration) return;
      this.skills = [];
      console.warn(`Failed to load ${this.agentType} skills`, error);
    } finally {
      if (this.disposed || generation !== this.skillsRequestGeneration) return;
      this.skillsLoading = false;
      this.activeIndex = 0;
      this.renderMenuItems();
      this.updateMenuPosition();
    }
  }

  private renderSkillsMenu(menu: HTMLDivElement): void {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "agent-composer-slash-menu__item agent-composer-slash-menu__item--back";
    back.textContent = "‹ 返回命令";
    back.addEventListener("pointerdown", (event) => event.preventDefault());
    back.addEventListener("click", () => {
      this.menuMode = "commands";
      this.editor.commands.setContent("/", { contentType: "markdown", emitUpdate: false });
      this.editor.commands.focus("end");
      this.refresh();
    });
    menu.append(back);

    if (this.skillsLoading) {
      const loading = document.createElement("div");
      loading.className = "agent-composer-slash-menu__empty";
      loading.textContent = "正在加载 Skill…";
      menu.append(loading);
      return;
    }
    if (this.skills.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agent-composer-slash-menu__empty";
      empty.textContent = "没有可用 Skill";
      menu.append(empty);
      return;
    }

    this.skills.forEach((skill, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-composer-slash-menu__item agent-composer-slash-menu__item--skill";
      item.classList.toggle("agent-composer-slash-menu__item--active", index === this.activeIndex);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.activeIndex));
      const name = document.createElement("span");
      name.className = "agent-composer-slash-menu__name";
      name.textContent = this.agentType === "codex"
        ? displayNameForComposerSkill(skill.name, skill.displayName)
        : skill.displayName || `/${skill.name}`;
      const description = document.createElement("span");
      description.className = "agent-composer-slash-menu__description";
      description.textContent = skill.shortDescription || skill.description || skill.whenToUse || "";
      item.append(name, description);
      item.addEventListener("mousemove", (event) => this.handleItemMouseMove(event, index));
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => this.selectSkill(skill));
      menu.append(item);
    });
    const activeItem = menu.children[this.activeIndex + 1] as HTMLElement | undefined;
    activeItem?.scrollIntoView?.({ block: "nearest" });
  }

  private selectSkill(skill: ComposerSlashSkill): void {
    this.closeMenu();
    this.menuMode = "commands";
    if (this.agentType === "codex") {
      insertComposerSkillToken(this.editor, skill.name, skill.displayName);
    } else {
      insertComposerSlashToken(this.editor, skill.name, "deepseek-harness");
    }
    this.onCommandChange();
  }

  removeSelectedToken(): void {
    if (!getComposerSlashToken(this.editor)) return;
    removeComposerSlashToken(this.editor);
    this.editor.commands.focus(null, { scrollIntoView: false });
    this.onCommandChange();
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    this.skillsRequestGeneration += 1;
    this.skillsLoading = false;
    this.menuMode = "commands";
  }
}
