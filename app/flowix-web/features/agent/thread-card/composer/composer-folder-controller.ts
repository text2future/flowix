import type { Editor } from "@tiptap/core";
import {
  insertComposerFolderToken,
} from "@features/agent/thread-card/composer/composer-folder-token";
import {
  toNoteReferenceAttrs,
  type MentionNoteItem,
} from "@features/editor/public/mention-data-api";

export interface ComposerFolderReference {
  path: string;
  name: string;
}

const NOTE_SEARCH_DEBOUNCE_MS = 150;
const MENU_SCROLLBAR_HIDE_DELAY_MS = 700;

export interface ComposerFolderControllerOptions {
  editor: Editor;
  input: HTMLDivElement;
  composer: HTMLElement;
  listFolders: () => readonly ComposerFolderReference[];
  groupLabel?: string;
  listNotes?: (query: string) => Promise<readonly MentionNoteItem[]>;
  noteGroupLabel?: string;
  noteEmptyLabel?: string;
  onChange?: () => void;
  focusInput?: () => void;
}

/**
 * `@` picker for the current notebook's configured Agent data folders.
 * Presentation intentionally uses the same menu contract as the slash picker
 * so the two interactions feel like one composer system.
 */
export class ComposerFolderController {
  private readonly editor: Editor;
  private readonly input: HTMLDivElement;
  private readonly composer: HTMLElement;
  private readonly listFolders: () => readonly ComposerFolderReference[];
  private readonly groupLabel: string;
  private readonly listNotes: (query: string) => Promise<readonly MentionNoteItem[]>;
  private readonly noteGroupLabel: string;
  private readonly noteEmptyLabel: string;
  private readonly onChange: () => void;
  private readonly focusInput: () => void;
  private menu: HTMLDivElement | null = null;
  private filteredFolders: readonly ComposerFolderReference[] = [];
  private notes: readonly MentionNoteItem[] = [];
  private notesLoading = false;
  private notesRequestGeneration = 0;
  private notesSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private menuScrollbarHideTimer: ReturnType<typeof setTimeout> | null = null;
  private activeIndex = 0;
  private isKeyboardNavigation = true;
  private dismissedValue: string | null = null;
  private disposed = false;
  private isComposing = false;
  private mentionRange: { from: number; to: number } | null = null;

  constructor(options: ComposerFolderControllerOptions) {
    this.editor = options.editor;
    this.input = options.input;
    this.composer = options.composer;
    this.listFolders = options.listFolders;
    this.groupLabel = options.groupLabel ?? "引用仓库";
    this.listNotes = options.listNotes ?? (async () => []);
    this.noteGroupLabel = options.noteGroupLabel ?? "笔记";
    this.noteEmptyLabel = options.noteEmptyLabel ?? "暂无笔记";
    this.onChange = options.onChange ?? (() => undefined);
    this.focusInput = options.focusInput ?? (() => {
      this.editor.commands.focus(null, { scrollIntoView: false });
      this.editor.view.focus();
    });

    this.input.addEventListener("keydown", this.handleKeydown, true);
    this.input.addEventListener("compositionstart", this.handleCompositionStart);
    this.input.addEventListener("compositionend", this.handleCompositionEnd);
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
    this.input.removeEventListener("compositionstart", this.handleCompositionStart);
    this.input.removeEventListener("compositionend", this.handleCompositionEnd);
    this.editor.off("update", this.handleEditorUpdate);
    this.editor.off("selectionUpdate", this.handleSelectionUpdate);
    document.removeEventListener("pointerdown", this.handleOutsidePointerDown, true);
    window.removeEventListener("resize", this.updateMenuPosition);
    window.removeEventListener("scroll", this.updateMenuPosition, true);
    this.cancelPendingNoteSearch();
    this.closeMenu();
  }

  refresh(): void {
    if (this.disposed || this.isComposing) return;
    const mention = this.getMentionAtCursor();
    if (!mention || mention.value === this.dismissedValue) {
      this.mentionRange = null;
      this.cancelPendingNoteSearch();
      this.closeMenu();
      return;
    }

    const query = mention.query.toLocaleLowerCase();
    this.filteredFolders = this.listFolders()
      .filter((folder) => folder.path.trim())
      .filter((folder, index, folders) => folders.findIndex(
        (candidate) => candidate.path === folder.path,
      ) === index)
      .filter((folder) => (
        folder.name.toLocaleLowerCase().includes(query) ||
        folder.path.toLocaleLowerCase().includes(query)
      ));
    this.mentionRange = { from: mention.from, to: mention.to };
    this.notes = [];
    this.notesLoading = true;
    this.activeIndex = 0;
    this.isKeyboardNavigation = true;
    // Do not flash an empty/loading popup when there are no matching folders.
    // The async note search will open it later if it finds anything.
    if (this.filteredFolders.length > 0) {
      this.openMenu();
    } else {
      this.closeMenu();
    }
    this.scheduleNoteSearch(mention.query);
  }

  private readonly handleCompositionStart = (): void => {
    this.isComposing = true;
    // IME input can update the ProseMirror document before compositionend.
    // Invalidate an in-flight/debounced query so unfinished text never reaches
    // the notebook search endpoint.
    this.cancelPendingNoteSearch();
    this.notesLoading = false;
  };

  private readonly handleCompositionEnd = (): void => {
    this.isComposing = false;
    // Let the final composition input settle in ProseMirror before reading the
    // cursor query. This mirrors the dedicated note-search input behavior.
    window.setTimeout(() => {
      if (!this.disposed && !this.isComposing) this.refresh();
    }, 0);
  };

  private scheduleNoteSearch(query: string): void {
    this.cancelPendingNoteSearch();
    const generation = ++this.notesRequestGeneration;
    this.notesLoading = true;
    this.notesSearchTimer = setTimeout(() => {
      this.notesSearchTimer = null;
      void this.loadNotes(query, generation);
    }, NOTE_SEARCH_DEBOUNCE_MS);
  }

  private cancelPendingNoteSearch(): void {
    if (this.notesSearchTimer !== null) {
      clearTimeout(this.notesSearchTimer);
      this.notesSearchTimer = null;
    }
    // Advance the generation so an already-running request cannot repaint the
    // menu after the query was dismissed or replaced.
    this.notesRequestGeneration += 1;
  }

  private async loadNotes(query: string, generation: number): Promise<void> {
    try {
      const notes = await this.listNotes(query);
      if (this.disposed || generation !== this.notesRequestGeneration) return;
      const mention = this.getMentionAtCursor();
      if (!mention || mention.query !== query) return;
      this.notes = notes;
      this.mentionRange = { from: mention.from, to: mention.to };
    } catch (error) {
      if (this.disposed || generation !== this.notesRequestGeneration) return;
      this.notes = [];
      console.warn("[agent-composer] note mention query failed:", error);
    } finally {
      if (this.disposed || generation !== this.notesRequestGeneration) return;
      this.notesLoading = false;
      const itemCount = this.getMenuItems().length;
      if (itemCount === 0) {
        this.closeMenu();
        return;
      }
      this.activeIndex = Math.min(this.activeIndex, itemCount - 1);
      if (this.menu) {
        this.renderMenuItems();
      } else {
        this.openMenu();
      }
    }
  }

  private getMenuItems(): Array<
    | { kind: "folder"; value: ComposerFolderReference }
    | { kind: "note"; value: MentionNoteItem }
  > {
    return [
      ...this.filteredFolders.map((value) => ({ kind: "folder" as const, value })),
      ...this.notes.map((value) => ({ kind: "note" as const, value })),
    ];
  }

  private getMentionAtCursor(): {
    from: number;
    to: number;
    query: string;
    value: string;
  } | null {
    const { selection } = this.editor.state;
    if (!selection.empty) return null;

    const blockStart = selection.$from.start();
    const textBefore = selection.$from.parent.textBetween(
      0,
      selection.$from.parentOffset,
      "\n",
      "\n",
    );
    // `@` is an explicit composer trigger, so it should work immediately
    // after other text as well as at the beginning of a line. Use the last
    // `@` before the cursor as the active mention anchor.
    const match = /@([\p{L}\p{N}._-]*)$/u.exec(textBefore);
    if (!match) return null;
    const mentionOffset = match.index;
    const from = blockStart + mentionOffset;
    const to = selection.from;
    return {
      from,
      to,
      query: match[1],
      value: textBefore.slice(mentionOffset),
    };
  }

  private readonly handleEditorUpdate = (): void => {
    this.dismissedValue = null;
    if (this.isComposing) return;
    this.refresh();
  };

  private readonly handleSelectionUpdate = (): void => {
    this.refresh();
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return;
    if (!this.menu) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const items = this.getMenuItems();
      if (items.length === 0) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      this.activeIndex = (this.activeIndex + direction + items.length) % items.length;
      this.isKeyboardNavigation = true;
      this.renderMenuItems();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const item = this.getMenuItems()[this.activeIndex];
      if (item) this.select(item);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.dismissedValue = this.editor.getMarkdown().trim();
      this.closeMenu();
    }
  };

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    if (!this.menu) return;
    const target = event.target as Node | null;
    if (target && (this.composer.contains(target) || this.menu.contains(target))) return;
    this.dismissedValue = this.editor.getMarkdown().trim();
    this.cancelPendingNoteSearch();
    this.closeMenu();
  };

  private openMenu(): void {
    if (!this.menu) {
      this.menu = document.createElement("div");
      this.menu.className = "agent-composer-slash-menu agent-composer-slash-menu--folder";
      this.menu.setAttribute("role", "listbox");
      this.menu.setAttribute("aria-label", "资料和笔记");
      this.menu.setAttribute("data-flowix-surface", "popover");
      this.menu.addEventListener("scroll", this.handleMenuScroll, { passive: true });
      document.body.append(this.menu);
    }
    this.renderMenuItems();
    this.updateMenuPosition();
  }

  private readonly handleMenuScroll = (): void => {
    const menu = this.menu;
    if (!menu) return;
    menu.dataset.scrolling = "true";
    if (this.menuScrollbarHideTimer !== null) {
      clearTimeout(this.menuScrollbarHideTimer);
    }
    this.menuScrollbarHideTimer = setTimeout(() => {
      if (this.menu === menu) delete menu.dataset.scrolling;
      this.menuScrollbarHideTimer = null;
    }, MENU_SCROLLBAR_HIDE_DELAY_MS);
  };

  private renderMenuItems(): void {
    const menu = this.menu;
    if (!menu) return;
    menu.classList.toggle("is-keyboard-navigation", this.isKeyboardNavigation);
    menu.replaceChildren();
    if (this.filteredFolders.length > 0) {
      const groupLabel = document.createElement("div");
      groupLabel.className = "agent-thread-card__codex-settings-title";
      groupLabel.textContent = this.groupLabel;
      menu.append(groupLabel);
    }
    this.filteredFolders.forEach((folder, index) => {
      this.renderFolderItem(menu, folder, index);
    });

    const noteGroupLabel = document.createElement("div");
    noteGroupLabel.className = "agent-thread-card__codex-settings-title";
    noteGroupLabel.textContent = this.noteGroupLabel;
    menu.append(noteGroupLabel);
    if (this.notesLoading) {
      const loading = document.createElement("div");
      loading.className = "agent-composer-slash-menu__empty";
      loading.textContent = "正在搜索笔记…";
      menu.append(loading);
    } else if (this.notes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agent-composer-slash-menu__empty";
      empty.textContent = this.noteEmptyLabel;
      menu.append(empty);
    } else {
      this.notes.forEach((note, index) => {
        this.renderNoteItem(menu, note, this.filteredFolders.length + index);
      });
    }
    const activeItem = menu.querySelectorAll<HTMLElement>('[role="option"]')[this.activeIndex];
    activeItem?.scrollIntoView?.({ block: "nearest" });
  }

  private renderFolderItem(
    menu: HTMLDivElement,
    folder: ComposerFolderReference,
    index: number,
  ): void {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-composer-slash-menu__item agent-composer-slash-menu__item--folder";
      item.classList.toggle("agent-composer-slash-menu__item--active", index === this.activeIndex);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.activeIndex));

      const name = document.createElement("span");
      name.className = "agent-composer-slash-menu__name";
      name.textContent = folder.name;
      const description = document.createElement("span");
      description.className = "agent-composer-slash-menu__description";
      description.textContent = folder.path;
      item.append(name, description);
      item.addEventListener("mousemove", (event) => this.handleItemMouseMove(event, index));
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => this.select({ kind: "folder", value: folder }));
      menu.append(item);
  }

  private renderNoteItem(
    menu: HTMLDivElement,
    note: MentionNoteItem,
    index: number,
  ): void {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "agent-composer-slash-menu__item agent-composer-slash-menu__item--note";
    item.classList.toggle("agent-composer-slash-menu__item--active", index === this.activeIndex);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === this.activeIndex));

    const name = document.createElement("span");
    name.className = "agent-composer-slash-menu__name";
    name.textContent = note.title || note.filename;
    const notebook = document.createElement("span");
    notebook.className = "agent-composer-slash-menu__description";
    notebook.textContent = note.notebookName;
    item.append(name, notebook);
    item.addEventListener("mousemove", (event) => this.handleItemMouseMove(event, index));
    item.addEventListener("pointerdown", (event) => event.preventDefault());
    item.addEventListener("click", () => this.select({ kind: "note", value: note }));
    menu.append(item);
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
    if (event.movementX === 0 && event.movementY === 0) return;
    if (this.activeIndex === index && !this.isKeyboardNavigation) return;
    this.activeIndex = index;
    this.isKeyboardNavigation = false;
    this.renderMenuItems();
  }

  private select(item: {
    kind: "folder";
    value: ComposerFolderReference;
  } | {
    kind: "note";
    value: MentionNoteItem;
  }): void {
    const range = this.mentionRange;
    if (!range) return;
    this.closeMenu();
    if (item.kind === "folder") {
      insertComposerFolderToken(this.editor, item.value.path, item.value.name, range);
    } else {
      this.editor.chain()
        .focus(null, { scrollIntoView: false })
        .insertContentAt({ from: range.from, to: range.to }, [
          { type: "noteReference", attrs: toNoteReferenceAttrs(item.value) },
          { type: "text", text: " " },
        ])
        .run();
    }
    this.focusInput();
    this.onChange();
  }

  private closeMenu(): void {
    if (this.menuScrollbarHideTimer !== null) {
      clearTimeout(this.menuScrollbarHideTimer);
      this.menuScrollbarHideTimer = null;
    }
    this.menu?.remove();
    this.menu = null;
    this.mentionRange = null;
  }
}
