import { createPopupScrollAreaDom } from '@shared/ui/popup-scroll-area-dom';
import type { Editor } from "@tiptap/core";
import {
  getComposerSlashToken,
  insertComposerSlashToken,
  removeComposerSlashToken,
  createSkillLibraryIcon,
} from "@features/agent/thread-card/composer/composer-slash-token";
import {
  displayNameForComposerSkill,
  insertComposerSkillToken,
  preferredComposerSkillName,
} from "@features/agent/thread-card/composer/composer-skill-token";
import type { AgentTypeKey } from "@/types/agent";
import { translate } from "@/lib/i18n";
import { getCurrentAppLanguage } from "@features/preferences/public/runtime-api";

import { COMPOSER_SLASH_COMMANDS, type ComposerSlashCommand } from "./composer-commands";
import { useAgentDataStore } from "@features/agent/store/agent-data-store";
import {
  NOTEBOOK_SKILLS_CHANGED_EVENT,
  type NotebookSkillsChangedDetail,
} from "@features/agent/services/notebook-skills-events";
export { COMPOSER_SLASH_COMMANDS, type ComposerSlashCommand } from "./composer-commands";


export interface ComposerSlashSkill {
  name: string;
  description: string;
  displayName?: string;
  shortDescription?: string;
  scope?: string;
  whenToUse?: string;
  modelInvocable?: boolean;
  enabled?: boolean;
}

function composerSkillScopeLabel(scope?: string): string | undefined {
  switch (scope) {
    case "repo":
    case "workspace":
      return "项目";
    case "user":
      return "个人";
    case "system":
    case "admin":
    case "managed":
      return "系统";
    default:
      return undefined;
  }
}

type ComposerSlashMenuItem =
  | { kind: "command"; value: ComposerSlashCommand }
  | { kind: "skill"; value: ComposerSlashSkill };

export { formatCodexSkillDisplayName } from "@features/agent/thread-card/composer/composer-skill-token";

const COMMAND_TITLE_KEYS = {
  compact: "editor.threadCard.composer.slash.compact",
  skill: "editor.threadCard.composer.slash.skill",
  goal: "editor.threadCard.composer.slash.goal",
  plan: "editor.threadCard.composer.slash.plan",
  model: "editor.threadCard.composer.slash.model",
  permission: "editor.threadCard.composer.slash.permission",
  export: "editor.threadCard.composer.slash.export",
} as const;

function createSlashMenuIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("agent-composer-slash-menu__icon");
  for (const d of ["M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z", "M15 9 9 15"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export interface ComposerSlashCommandControllerOptions {
  editor: Editor;
  input: HTMLDivElement;
  composer: HTMLElement;
  commands?: readonly ComposerSlashCommand[];
  agentType?: AgentTypeKey;
  getSkillsScopeId?: () => string | undefined;
  listDshSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  listCodexSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  listPiSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  onModelSelect?: () => void;
  onPermissionSelect?: () => void;
  onDirectCommand?: (command: ComposerSlashCommand) => void;
  canExecuteCommand?: (command: ComposerSlashCommand) => boolean;
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
  private readonly getSkillsScopeId: (() => string | undefined) | undefined;
  private readonly listDshSkills: (() => Promise<readonly ComposerSlashSkill[]>) | undefined;
  private readonly listCodexSkills: (() => Promise<readonly ComposerSlashSkill[]>) | undefined;
  private readonly listPiSkills: (() => Promise<readonly ComposerSlashSkill[]>) | undefined;
  private readonly onModelSelect: (() => void) | undefined;
  private readonly onPermissionSelect: (() => void) | undefined;
  private readonly canExecuteCommand: ComposerSlashCommandControllerOptions["canExecuteCommand"];
  private readonly onDirectCommand: ((command: ComposerSlashCommand) => void) | undefined;
  private readonly onCommandChange: () => void;
  private readonly focusInput: () => void;
  private readonly inputRow: HTMLDivElement;
  private menu: HTMLDivElement | null = null;
  private filtered: readonly ComposerSlashMenuItem[] = [];
  private skills: readonly ComposerSlashSkill[] = [];
  private skillsStatus: "idle" | "loading" | "ready" | "error" = "idle";
  private skillsScopeId: string | null = null;
  private skillsRequestId = 0;
  private activeIndex = 0;
  private isKeyboardNavigation = true;
  private dismissedValue: string | null = null;
  private slashActive = false;
  private forcedSlashMenuRequested = false;
  private disposed = false;
  private menuScrollbar: ReturnType<typeof createPopupScrollAreaDom> | null = null;

  constructor(options: ComposerSlashCommandControllerOptions) {
    this.editor = options.editor;
    this.input = options.input;
    this.composer = options.composer;
    this.commands = options.commands ?? COMPOSER_SLASH_COMMANDS;
    this.agentType = options.agentType;
    this.getSkillsScopeId = options.getSkillsScopeId;
    this.listDshSkills = options.listDshSkills;
    this.listCodexSkills = options.listCodexSkills;
    this.listPiSkills = options.listPiSkills;
    this.onModelSelect = options.onModelSelect;
    this.onPermissionSelect = options.onPermissionSelect;
    this.onDirectCommand = options.onDirectCommand;
    this.canExecuteCommand = options.canExecuteCommand;
    this.onCommandChange = options.onCommandChange ?? (() => undefined);
    this.focusInput = options.focusInput ?? (() => {
      this.editor.commands.focus(null, { scrollIntoView: false });
      this.editor.view.focus();
    });

    const inputRow = this.input.parentElement;
    if (!inputRow?.classList.contains("agent-composer__input-row")) {
      throw new Error("Composer DOM must provide its input row before initialization");
    }
    this.inputRow = inputRow as HTMLDivElement;

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
    window.addEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, this.handleNotebookSkillsChanged);
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
    window.removeEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, this.handleNotebookSkillsChanged);
    this.closeMenu();
    removeComposerSlashToken(this.editor);
  }

  private readonly handleNotebookSkillsChanged = (event: Event): void => {
    const detail = (event as CustomEvent<NotebookSkillsChangedDetail>).detail;
    const scope = this.getSkillsScopeId?.()?.trim() || "global";
    if (!detail || (scope !== detail.notebookId && scope !== detail.notebookPath)) return;
    this.skillsRequestId += 1;
    this.skillsStatus = "idle";
    if (this.menu) this.refresh(true);
  };

  refresh(preserveSelection = false): void {
    // Keep the agent scope at the controller boundary so unscoped/custom
    // descriptors cannot accidentally make a command available to another
    // Agent.
    if (this.disposed || !this.agentType || getComposerSlashToken(this.editor)) {
      this.slashActive = false;
      this.forcedSlashMenuRequested = false;
      this.closeMenu();
      return;
    }

    const scopeId = this.getSkillsScopeId?.()?.trim() || "global";
    if (scopeId !== this.skillsScopeId) {
      this.skillsScopeId = scopeId;
      this.skillsRequestId += 1;
      this.skills = [];
      this.skillsStatus = "idle";
    }
    const previousItem = preserveSelection ? this.filtered[this.activeIndex] : undefined;
    const { selection, doc } = this.editor.state;
    const value = this.editor.getMarkdown().trim();
    const cursorAtEnd = selection.empty && selection.from === doc.content.size - 1;
    const match = cursorAtEnd ? /^\/([a-z0-9._-]*)$/i.exec(value) : null;
    const isForcedSlashMenuRequested = this.forcedSlashMenuRequested && !match;
    if (!match && !isForcedSlashMenuRequested) {
      this.slashActive = false;
      this.closeMenu();
      return;
    }
    if (match && value === this.dismissedValue) {
      this.closeMenu();
      return;
    }

    // Refresh once per slash entry, including after a transient failure.
    // Filtering an open slash must not start another catalog request.
    const isSlashMenuEntry = Boolean(match) || isForcedSlashMenuRequested;
    if (isSlashMenuEntry && !this.slashActive &&
      (this.skillsStatus === "ready" || this.skillsStatus === "error")) {
      this.skillsStatus = "idle";
    }
    this.slashActive = isSlashMenuEntry;
    const query = match ? match[1].toLowerCase() : "";
    const commands: readonly ComposerSlashMenuItem[] = this.commands
      .filter((command) => !command.agentType || command.agentType === this.agentType)
      // Skills are now direct candidates in this list; the old `/skill`
      // submenu entry would only duplicate that behavior.
      .filter((command) => command.execution !== "dsh-skill" && command.execution !== "codex-skill")
      .map((command) => ({ kind: "command" as const, value: command }));
    const skillsAreVisible = this.skillsStatus === "ready" ||
      (this.skillsStatus === "loading" && this.skills.length > 0);
    const skills: readonly ComposerSlashMenuItem[] = skillsAreVisible
      // Shared caches can contain the full settings catalog, including disabled skills.
      ? this.skills.filter((skill) => skill.enabled !== false)
        .map((skill) => ({ kind: "skill" as const, value: skill }))
      : [];
    this.filtered = [...commands, ...skills].filter((item) => {
      const value = item.value.name;
      const label = item.kind === "skill"
        ? `${item.value.displayName ?? ""} ${item.value.description} ${item.value.shortDescription ?? ""} ${composerSkillScopeLabel(item.value.scope) ?? ""}`
        : item.value.description;
      return `${value} ${label}`.toLowerCase().includes(query);
    });
    if (
      this.filtered.length === 0 &&
      this.skillsStatus !== "idle" &&
      this.skillsStatus !== "loading" &&
      this.skillsStatus !== "error"
    ) {
      this.closeMenu();
      return;
    }
    const previousIndex = previousItem ? this.filtered.findIndex((item) =>
      item.kind === previousItem.kind && item.value.name === previousItem.value.name,
    ) : -1;
    this.activeIndex = previousIndex >= 0 ? previousIndex : 0;
    if (!preserveSelection) this.isKeyboardNavigation = true;
    this.openMenu();
    void this.ensureSkillsLoaded();
  }

  private readonly handleEditorUpdate = (): void => {
    this.forcedSlashMenuRequested = false;
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
        const count = this.filtered.length;
        if (count === 0) return;
        this.activeIndex = (this.activeIndex + direction + count) % count;
        this.isKeyboardNavigation = true;
        this.renderMenuItems();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const item = this.filtered[this.activeIndex];
        if (item?.kind === "command") this.select(item.value);
        if (item?.kind === "skill") this.selectSkill(item.value);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.forcedSlashMenuRequested = false;
        this.dismissedValue = this.editor.getMarkdown().trim();
        this.slashActive = false;
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
    this.forcedSlashMenuRequested = false;
    this.dismissedValue = this.editor.getMarkdown().trim();
    this.slashActive = false;
    this.closeMenu();
  };

  private openMenu(): void {
    if (!this.menu) {
      this.menuScrollbar = createPopupScrollAreaDom(document, { frameClassName: "popup-scroll-area--surface agent-composer-slash-menu" });
      this.menu = this.menuScrollbar.frame;
      this.menuScrollbar.scroller.setAttribute("role", "listbox");
      this.menuScrollbar.scroller.setAttribute("aria-label", "Slash commands");
      this.menu.setAttribute("data-flowix-surface", "popover");
      document.body.append(this.menu);
    }
    this.renderMenuItems();
    this.updateMenuPosition();
  }

  private renderMenuItems(): void {
    const menu = this.menuScrollbar?.scroller;
    if (!menu) return;
    this.menu?.setAttribute("aria-busy", String(this.skillsStatus === "loading"));
    this.menu?.classList.toggle("is-keyboard-navigation", this.isKeyboardNavigation);
    menu.replaceChildren();

    const appendSection = (
      label: "editor.threadCard.composer.slash.quickCommands" | "editor.threadCard.composer.slash.allSkills",
    ): void => {
      const section = document.createElement("div");
      section.className = "agent-composer-slash-menu__section";
      section.setAttribute("role", "presentation");
      section.textContent = translate(getCurrentAppLanguage(), label);
      menu.append(section);
    };
    let renderedCommandSection = false;
    let renderedSkillSection = false;
    this.filtered.forEach((candidate, index) => {
      if (candidate.kind === "command" && !renderedCommandSection) {
        appendSection("editor.threadCard.composer.slash.quickCommands");
        renderedCommandSection = true;
      }
      if (candidate.kind === "skill" && !renderedSkillSection) {
        appendSection("editor.threadCard.composer.slash.allSkills");
        renderedSkillSection = true;
      }

      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-composer-slash-menu__item";
      item.classList.toggle("agent-composer-slash-menu__item--active", index === this.activeIndex);
      item.classList.add(candidate.kind === "skill"
        ? "agent-composer-slash-menu__item--skill"
        : "agent-composer-slash-menu__item--command");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.activeIndex));
      const icon = candidate.kind === "skill"
        ? createSkillLibraryIcon()
        : createSlashMenuIcon();
      icon.classList.remove("agent-composer__skill-token-icon");
      icon.classList.add("agent-composer-slash-menu__icon");
      if (candidate.kind === "skill") {
        icon.classList.add("agent-composer-slash-menu__icon--skill");
        if (candidate.value.scope === "repo" || candidate.value.scope === "workspace") {
          icon.classList.add("agent-composer-slash-menu__icon--project");
        }
      }
      item.append(icon);
      const name = document.createElement("span");
      name.className = "agent-composer-slash-menu__name";
      name.textContent = candidate.kind === "command"
        ? translate(getCurrentAppLanguage(), COMMAND_TITLE_KEYS[candidate.value.name as keyof typeof COMMAND_TITLE_KEYS] ?? "editor.threadCard.composer.slash.skill")
        : this.agentType === "codex"
          ? displayNameForComposerSkill(candidate.value.name, candidate.value.displayName)
          : preferredComposerSkillName(candidate.value.name, candidate.value.displayName);
      if (candidate.kind === "skill") {
        const scopeLabel = composerSkillScopeLabel(candidate.value.scope);
        item.append(name);
        if (scopeLabel) {
          const scope = document.createElement("span");
          scope.className = "agent-composer-slash-menu__scope";
          scope.textContent = scopeLabel;
          item.append(scope);
        }
      } else {
        item.append(name);
      }
      item.addEventListener("mousemove", (event) => this.handleItemMouseMove(event, index));
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => {
        if (candidate.kind === "command") this.select(candidate.value);
        else this.selectSkill(candidate.value);
      });
      menu.append(item);
    });

    if (!renderedSkillSection && (this.skillsStatus === "loading" || this.skillsStatus === "error")) {
      appendSection("editor.threadCard.composer.slash.allSkills");
    }
    if (this.skillsStatus === "loading") {
      const loading = document.createElement("div");
      loading.className = "agent-composer-slash-menu__empty agent-composer-slash-menu__empty--loading";
      loading.setAttribute("role", "status");
      loading.textContent = "正在加载 Skill…";
      menu.prepend(loading);
    } else if (this.skillsStatus === "error") {
      const error = document.createElement("div");
      error.className = "agent-composer-slash-menu__empty";
      error.textContent = "Skill 加载失败，请稍后重试";
      menu.append(error);
    }
    const activeItem = menu.querySelectorAll<HTMLElement>("[role='option']")[this.activeIndex];
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
    if ((command.interaction === "direct" || command.execution === "host-action") &&
      this.canExecuteCommand && !this.canExecuteCommand(command)) return;
    this.forcedSlashMenuRequested = false;
    this.closeMenu();
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
      insertComposerSlashToken(this.editor, command.name, command.agentType);
      this.onCommandChange();
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

  private async ensureSkillsLoaded(): Promise<void> {
    if (!this.agentType || this.skillsStatus === "ready" || this.skillsStatus === "loading" || this.skillsStatus === "error") return;
    const listSkills = this.agentType === "codex"
      ? this.listCodexSkills
      : this.agentType === "pi"
        ? this.listPiSkills
        : this.listDshSkills;
    if (!listSkills) {
      this.skillsStatus = "ready";
      this.refresh();
      return;
    }
    const scopeId = this.getSkillsScopeId?.()?.trim() || "global";
    const requestId = ++this.skillsRequestId;
    const isCurrentRequest = (): boolean => !this.disposed && requestId === this.skillsRequestId &&
      (this.getSkillsScopeId?.()?.trim() || "global") === scopeId;
    const cached = useAgentDataStore.getState().agents[this.agentType].catalog.skillsByNotebookId[scopeId];
    this.skills = cached?.items ?? [];
    this.skillsStatus = "loading";
    this.refresh(true);
    const skillsPromise = useAgentDataStore.getState().loadSkillCatalog(
      this.agentType,
      scopeId,
      async () => [...await listSkills()],
    );
    try {
      const skills = await skillsPromise;
      if (!isCurrentRequest()) {
        this.refreshForChangedSkillScope();
        return;
      }
      this.skills = skills;
      this.skillsStatus = "ready";
    } catch (error) {
      if (!isCurrentRequest()) {
        this.refreshForChangedSkillScope();
        return;
      }
      this.skillsStatus = this.skills.length ? "ready" : "error";
      console.warn(`Failed to load ${this.agentType} skills`, error);
    }
    this.refresh(true);
  }

  private refreshForChangedSkillScope(): void {
    const currentScopeId = this.getSkillsScopeId?.()?.trim() || "global";
    if (!this.disposed && this.menu && currentScopeId !== this.skillsScopeId) {
      this.refresh(true);
    }
  }

  selectSkill(skill: ComposerSlashSkill): void {
    this.forcedSlashMenuRequested = false;
    this.closeMenu();
    if (this.agentType === "codex") {
      insertComposerSkillToken(this.editor, skill.name, skill.displayName);
    } else if (this.agentType === "pi") {
      insertComposerSlashToken(this.editor, `skill:${skill.name}`, "pi", skill.displayName);
    } else {
      insertComposerSlashToken(this.editor, skill.name, "dsh");
    }
    this.onCommandChange();
  }

  /** Open the shared slash picker without changing the current draft. */
  openSlashMenu(): void {
    if (this.disposed || this.editor.isDestroyed || !this.agentType) return;
    this.forcedSlashMenuRequested = true;
    this.dismissedValue = null;
    this.activeIndex = 0;
    this.isKeyboardNavigation = true;
    this.focusInput();
    this.refresh();
  }

  removeSelectedToken(): void {
    if (!getComposerSlashToken(this.editor)) return;
    removeComposerSlashToken(this.editor);
    this.editor.commands.focus(null, { scrollIntoView: false });
    this.onCommandChange();
  }

  private closeMenu(): void {
    this.menuScrollbar?.destroy();
    this.menuScrollbar = null;
    this.menu?.remove();
    this.menu = null;
  }
}
