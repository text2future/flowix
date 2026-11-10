import type { I18nKey, I18nParams } from '@/lib/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { notes as notesClient, files, externalDocuments } from '@platform/tauri/client';
import { openNoteByNotebookPath } from '@features/memo/public/note-navigation-api';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import { parseTableDocumentAsync } from '@features/multidimensional-table/parse-table-document';
import { toast } from '@/lib/toast';
import { replayEnterAnimation } from '@/lib/replay-enter-animation';
import { applyPopoverPosition, calculateAnchoredPopoverPosition } from '../popover/popover-position';
import {
  appendFeaturedNoteIconContent,
  getFeaturedPathNoteCards,
  readFeaturedNotesTableSelection,
  writeFeaturedNotesTableSelection,
  type FeaturedNoteCard,
  type FeaturedNotesTableSelection,
} from "@features/agent/thread-card/settings/featured-note-cards";

const FEATURED_NOTES_VIEW_PICKER_WIDTH_PX = 272;
const FEATURED_NOTES_VIEW_PICKER_PADDING_PX = 8;
const FEATURED_NOTES_SCROLLBAR_HIDE_DELAY_MS = 700;
export interface FeaturedNoteReference {
  id: string;
  filename: string;
  title: string;
  notebookId?: string;
  relativePath?: string;
}

interface FeaturedNotesOptions {
  getNotebookId: () => string | null;
  t: (key: I18nKey, params?: I18nParams) => string;
  isDestroyed: () => boolean;
  onSelectFeaturedNote?: (ref: FeaturedNoteReference) => void;
}

/** Owns note queries, filtering UI and its detached popover lifecycle. */
export class FeaturedNotesController {
  private featuredNotesRequestId = 0;
  private featuredNotesViewportCleanup: (() => void) | null = null;
  private featuredNotesPanel: HTMLElement | null = null;
  private scrollbarHideTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(private readonly options: FeaturedNotesOptions) {}
  private getCurrentNotebookId = () => this.options.getNotebookId();
  private t = (key: I18nKey, params?: I18nParams) => this.options.t(key, params);
  private isDestroyed = () => this.disposed || this.options.isDestroyed();
  private get onSelectFeaturedNote() { return this.options.onSelectFeaturedNote; }
  dispose(): void {
    this.disposed = true;
    this.featuredNotesRequestId += 1;
    this.clearFeaturedNotesView();
  }

  clear(): void {
    this.featuredNotesRequestId += 1;
    this.clearFeaturedNotesView();
  }

  private clearFeaturedNotesView(): void {
    this.featuredNotesViewportCleanup?.();
    this.featuredNotesViewportCleanup = null;
    this.featuredNotesPanel?.remove();
    this.featuredNotesPanel = null;
  }

  async appendFeaturedNotes(empty: HTMLElement): Promise<void> {
    this.clearFeaturedNotesView();
    const requestId = ++this.featuredNotesRequestId;
    if (this.isDestroyed()) return;
    const notebookId = this.getCurrentNotebookId();
    if (!notebookId) return;

    const selection = await readFeaturedNotesTableSelection(notebookId);
    if (this.isDestroyed() || requestId !== this.featuredNotesRequestId) return;
    const renderPanel = (notes: FeaturedNoteCard[]): void => {
      if (
        this.isDestroyed()
        || requestId !== this.featuredNotesRequestId
        || this.getCurrentNotebookId() !== notebookId
        || !empty.isConnected
      ) return;
      const panel: HTMLElement = this.createFeaturedNotesElement(notes, selection, notebookId, () => {
        void this.refreshFeaturedNotes(empty, panel);
      });
      this.featuredNotesPanel = panel;
      if (empty.classList.contains("agent-thread-card__empty--expanded")) {
        empty.after(panel);
      } else {
        empty.append(panel);
      }
    };
    if (!selection) {
      renderPanel([]);
      return;
    }
    try {
      const indexed = await notesClient.list(notebookId);
      const notes = getFeaturedPathNoteCards(
        await this.loadSelectedTableNotes(notebookId, selection, indexed),
        null,
      );
      renderPanel(notes);
    } catch {
      // Keep the settings toggle available when the note index is unavailable;
      // otherwise users cannot choose a table to recover the empty state.
      renderPanel([]);
    }
  }

  /** Refresh the selected table in place so the empty state never collapses while loading. */
  private async refreshFeaturedNotes(empty: HTMLElement, currentPanel: HTMLElement): Promise<void> {
    const requestId = ++this.featuredNotesRequestId;
    const notebookId = this.getCurrentNotebookId();
    if (!notebookId || this.isDestroyed()) return;

    const selection = await readFeaturedNotesTableSelection(notebookId);
    if (this.isDestroyed() || requestId !== this.featuredNotesRequestId) return;
    let notes: FeaturedNoteCard[] = [];
    if (selection) {
      try {
        const indexed = await notesClient.list(notebookId);
        notes = getFeaturedPathNoteCards(
          await this.loadSelectedTableNotes(notebookId, selection, indexed),
          null,
        );
      } catch {
        // Keep the existing cards visible until the next successful refresh.
        return;
      }
    }
    if (
      this.isDestroyed()
      || requestId !== this.featuredNotesRequestId
      || this.getCurrentNotebookId() !== notebookId
      || !empty.isConnected
      || !currentPanel.isConnected
    ) return;

    this.featuredNotesViewportCleanup?.();
    this.featuredNotesViewportCleanup = null;
    const nextPanel: HTMLElement = this.createFeaturedNotesElement(notes, selection, notebookId, () => {
      void this.refreshFeaturedNotes(empty, nextPanel);
    });
    currentPanel.replaceWith(nextPanel);
    this.featuredNotesPanel = nextPanel;
  }

  private async loadSelectedTableNotes(notebookId: string, selection: FeaturedNotesTableSelection, indexed: Awaited<ReturnType<typeof notesClient.list>>) {
    const notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
    if (!notebook || notebook.missing) return [];
    const filePath = joinNotebookMemoPath(notebook.path, selection.relativePath);
    if (!filePath) return [];
    const source = await externalDocuments.read(filePath, notebook.path);
    const table = await parseTableDocumentAsync(source);
    if (table.collection.id !== selection.collectionId) return [];
    const notesByPath = new Map(indexed.map((note) => [note.relativePath, note]));
    return table.dataset.records.include.flatMap((record) => {
      const note = notesByPath.get(record.note_path);
      return note ? [note] : [];
    });
  }

  private createFeaturedNotesElement(
    notes: FeaturedNoteCard[],
    selection: FeaturedNotesTableSelection | null,
    notebookId: string,
    onFilterChange: () => void,
  ): HTMLElement {
    const panel = document.createElement("section");
    panel.className = "agent-thread-card__featured-notes";
    panel.setAttribute("aria-label", this.t("editor.threadCard.featuredNotes"));

    const headingRow = document.createElement("div");
    headingRow.className = "agent-thread-card__featured-notes-header";

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "agent-thread-card__featured-notes-settings-button";
    settingsButton.textContent = this.t("editor.threadCard.featuredNotes.settings");
    const iconTemplate = document.createElement("template");
    iconTemplate.innerHTML = renderToStaticMarkup(
      createElement(ChevronRight, { size: 14, strokeWidth: 2, "aria-hidden": true }),
    );
    const settingsIcon = iconTemplate.content.firstElementChild;
    if (settingsIcon) settingsButton.append(settingsIcon);
    settingsButton.setAttribute("aria-expanded", "false");
    headingRow.append(settingsButton);

    const navigation = document.createElement("div");
    navigation.className = "agent-thread-card__featured-notes-navigation";
    navigation.hidden = true;
    const previousButton = this.createFeaturedNotesNavigationButton(
      "left",
      this.t("editor.threadCard.featuredNotes.previous"),
    );
    const nextButton = this.createFeaturedNotesNavigationButton(
      "right",
      this.t("editor.threadCard.featuredNotes.next"),
    );
    navigation.append(previousButton, nextButton);
    const settingsFooter = document.createElement("div");
    settingsFooter.className = "agent-thread-card__featured-notes-settings-footer";
    settingsFooter.append(navigation);

    const settingsPopover = this.createTableSelectionPopover(
      notebookId,
      selection,
      () => {
        // A save/create action can finish after a different empty surface has mounted.
        if (this.isDestroyed() || this.featuredNotesPanel !== panel || !panel.isConnected) return;
        setSettingsOpen(false);
        onFilterChange();
      },
      () => setSettingsOpen(false),
    );
    document.body.append(settingsPopover);
    const positionSettingsPopover = (): void => {
      if (settingsPopover.hidden || !settingsPopover.isConnected) return;
      const anchorRect = settingsButton.getBoundingClientRect();
      const popoverRect = settingsPopover.getBoundingClientRect();
      applyPopoverPosition(settingsPopover, calculateAnchoredPopoverPosition({
        anchorRect,
        popoverWidth: popoverRect.width || FEATURED_NOTES_VIEW_PICKER_WIDTH_PX,
        popoverHeight: popoverRect.height || 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        padding: FEATURED_NOTES_VIEW_PICKER_PADDING_PX,
        offset: 6,
      }));
    };
    const popoverResizeObserver = new ResizeObserver(positionSettingsPopover);
    popoverResizeObserver.observe(settingsPopover);
    const setSettingsOpen = (open: boolean, restoreFocus = false): void => {
      // Outside pointers must keep their own focus destination. Only an
      // explicit keyboard dismissal may return focus from this popover.
      if (open === !settingsPopover.hidden) return;
      const returnFocus = !open && restoreFocus
        && settingsPopover.contains(document.activeElement);
      settingsPopover.hidden = !open;
      settingsButton.setAttribute("aria-expanded", String(open));
      if (open) {
        replayEnterAnimation(settingsPopover);
        positionSettingsPopover();
        (settingsPopover.querySelector<HTMLElement>(".agent-thread-card__featured-notes-view-option")
          ?? settingsPopover.querySelector<HTMLElement>(".agent-thread-card__featured-notes-view-create"))?.focus({ preventScroll: true });
      } else if (returnFocus) {
        settingsButton.focus({ preventScroll: true });
      }
    };
    settingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setSettingsOpen(settingsButton.getAttribute("aria-expanded") !== "true");
    });

    const list = document.createElement("div");
    list.className = "agent-thread-card__featured-notes-list";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", this.t("editor.threadCard.featuredNotes"));
    list.append(headingRow);
    for (const note of notes) {
      list.append(this.createFeaturedNoteCard(note, notebookId));
    }
    panel.append(list, settingsFooter);
    const updateNavigation = (): void => {
      const maxScrollLeft = Math.max(0, list.scrollWidth - list.clientWidth);
      const hasOverflow = maxScrollLeft > 1;
      navigation.hidden = !hasOverflow;
      settingsFooter.hidden = !hasOverflow;
      previousButton.disabled = list.scrollLeft <= 1;
      nextButton.disabled = list.scrollLeft >= maxScrollLeft - 1;
    };
    const scrollList = (direction: -1 | 1): void => {
      list.scrollBy({ left: direction * list.clientWidth, behavior: "smooth" });
    };
    previousButton.addEventListener("click", (event) => {
      event.stopPropagation();
      scrollList(-1);
    });
    nextButton.addEventListener("click", (event) => {
      event.stopPropagation();
      scrollList(1);
    });
    list.addEventListener("scroll", updateNavigation, { passive: true });
    const notesListResizeObserver = new ResizeObserver(updateNavigation);
    notesListResizeObserver.observe(list);
    updateNavigation();
    const handleWindowResize = (): void => positionSettingsPopover();
    const handleOutsidePointer = (event: PointerEvent): void => {
      if (settingsPopover.hidden) return;
      // 下拉层单独挂在 body, 点击内容区不关闭; 点击其他位置关闭。
      const target = event.target as Node;
      if (panel.contains(target) || settingsPopover.contains(target)) return;
      setSettingsOpen(false);
    };
    const handleEscape = (event: KeyboardEvent): void => {
      if (settingsPopover.hidden) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSettingsOpen(false, true);
    };
    window.addEventListener("resize", handleWindowResize);
    document.addEventListener("pointerdown", handleOutsidePointer);
    document.addEventListener("keydown", handleEscape);
    this.featuredNotesViewportCleanup = () => {
      popoverResizeObserver.disconnect();
      notesListResizeObserver.disconnect();
      list.removeEventListener("scroll", updateNavigation);
      window.removeEventListener("resize", handleWindowResize);
      document.removeEventListener("pointerdown", handleOutsidePointer);
      document.removeEventListener("keydown", handleEscape);
      if (this.scrollbarHideTimer !== null) {
        clearTimeout(this.scrollbarHideTimer);
        this.scrollbarHideTimer = null;
      }
      // 弹层挂在 document.body 上, 不随 panel 一起被移除, 必须显式清理,
      // 否则每次刷新精选笔记都会在 body 里留下一个孤儿弹层。
      settingsPopover.remove();
      this.featuredNotesViewportCleanup = null;
    };
    return panel;
  }

  private createTableSelectionPopover(
    notebookId: string,
    current: FeaturedNotesTableSelection | null,
    onChange: () => void,
    onCreateTable: () => void,
  ): HTMLDivElement {
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__featured-notes-view-picker";
    popover.hidden = true;
    const isCurrent = (): boolean => !this.isDestroyed()
      && popover.isConnected && this.getCurrentNotebookId() === notebookId;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", this.t("editor.threadCard.featuredNotes.settingsTitle"));
    popover.addEventListener("pointerdown", (event) => event.stopPropagation());
    const heading = document.createElement("div");
    heading.className = "agent-thread-card__featured-notes-view-heading";
    heading.textContent = this.t("editor.threadCard.featuredNotes.settingsTitle");
    const list = document.createElement("div");
    list.className = "agent-thread-card__featured-notes-view-list";
    const items = document.createElement("div");
    items.className = "agent-thread-card__featured-notes-view-items";
    items.setAttribute("role", "listbox");
    items.setAttribute("aria-label", this.t("editor.threadCard.featuredNotes.settingsTitle"));
    items.setAttribute("data-flowix-surface", "select");
    items.addEventListener("scroll", () => {
      items.dataset.scrolling = "true";
      if (this.scrollbarHideTimer !== null) clearTimeout(this.scrollbarHideTimer);
      this.scrollbarHideTimer = setTimeout(() => {
        delete items.dataset.scrolling;
        this.scrollbarHideTimer = null;
      }, FEATURED_NOTES_SCROLLBAR_HIDE_DELAY_MS);
    }, { passive: true });
    const status = document.createElement("div");
    status.className = "agent-thread-card__featured-notes-view-status";
    status.textContent = this.t("editor.threadCard.featuredNotes.loadingTables");
    items.append(status);
    list.append(items);
    popover.append(heading, list);
    this.appendCreateTableAction(popover, notebookId, onChange, onCreateTable);

    void (async () => {
      const notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
      if (!notebook || notebook.missing) {
        status.textContent = this.t("editor.threadCard.featuredNotes.noTables");
        return;
      }
      try {
        const docs = await files.listTableDocuments(notebookId);
        if (!isCurrent()) return;
        const tables = docs.map((doc) => ({
            name: doc.name,
            selection: { relativePath: doc.relativePath, collectionId: doc.collectionId },
          }));
        items.replaceChildren();
        if (!tables.length) {
          status.textContent = this.t("editor.threadCard.featuredNotes.noTables");
          items.append(status);
          return;
        }
        for (const entry of tables) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "agent-thread-card__featured-notes-view-option";
          button.setAttribute("role", "option");
          button.setAttribute("aria-selected", String(current?.relativePath === entry.selection.relativePath && current.collectionId === entry.selection.collectionId));
          const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          icon.setAttribute("class", "agent-thread-card__featured-notes-view-option-icon");
          icon.setAttribute("viewBox", "0 0 24 24");
          icon.setAttribute("width", "16");
          icon.setAttribute("height", "16");
          icon.setAttribute("fill", "none");
          icon.setAttribute("stroke", "currentColor");
          icon.setAttribute("stroke-width", "1.8");
          icon.setAttribute("stroke-linecap", "round");
          icon.setAttribute("stroke-linejoin", "round");
          icon.setAttribute("aria-hidden", "true");
          const outline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          outline.setAttribute("x", "3"); outline.setAttribute("y", "3"); outline.setAttribute("width", "18"); outline.setAttribute("height", "18"); outline.setAttribute("rx", "2");
          const vertical = document.createElementNS("http://www.w3.org/2000/svg", "line");
          vertical.setAttribute("x1", "9"); vertical.setAttribute("y1", "3"); vertical.setAttribute("x2", "9"); vertical.setAttribute("y2", "21");
          const horizontal = document.createElementNS("http://www.w3.org/2000/svg", "line");
          horizontal.setAttribute("x1", "3"); horizontal.setAttribute("y1", "9"); horizontal.setAttribute("x2", "21"); horizontal.setAttribute("y2", "9");
          icon.append(outline, vertical, horizontal);
          const label = document.createElement("span");
          label.className = "agent-thread-card__featured-notes-view-option-label";
          const primary = document.createElement("span");
          primary.className = "agent-thread-card__featured-notes-view-option-title";
          primary.textContent = entry.name;
          label.append(primary);
          button.append(icon, label);
          button.setAttribute("aria-pressed", String(current?.relativePath === entry.selection.relativePath && current.collectionId === entry.selection.collectionId));
          button.addEventListener("mousedown", (event) => event.preventDefault());
          const saveSelection = async (): Promise<void> => {
            button.disabled = true;
            try {
              await writeFeaturedNotesTableSelection(notebookId, entry.selection);
              if (isCurrent()) onChange();
            } catch {
              if (!isCurrent()) return;
              button.disabled = false;
              toast.error(this.t("editor.threadCard.featuredNotes.saveFailed"));
            }
          };
          button.addEventListener("click", () => { void saveSelection(); });
          items.append(button);
        }
        status.remove();
      } catch {
        if (isCurrent()) status.textContent = this.t("editor.threadCard.featuredNotes.noTables");
      }
    })();
    return popover;
  }

  private appendCreateTableAction(container: HTMLElement, notebookId: string, onChange: () => void, onCreateTable: () => void): void {
    const create = document.createElement("button");
    create.type = "button";
    create.className = "flex h-8 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm text-[var(--foreground)] hover:bg-[var(--muted)] disabled:opacity-50";
    create.classList.add("agent-thread-card__featured-notes-view-create");
    create.textContent = this.t("editor.threadCard.featuredNotes.createTable");
    create.addEventListener("click", () => {
      onCreateTable();
      const notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
      if (!notebook || notebook.missing) return;
      const request = new CustomEvent("flowix:open-create-table-dialog", {
        cancelable: true,
        detail: {
          notebookId,
          onCreated: async (selection: FeaturedNotesTableSelection) => {
            await writeFeaturedNotesTableSelection(notebookId, selection);
            onChange();
          },
        },
      });
      window.dispatchEvent(request);
      if (!request.defaultPrevented) toast.error("无法打开多维表格创建窗口");
    });
    const row = document.createElement("div");
    row.className = "agent-thread-card__featured-notes-view-create-row";
    row.append(create);
    container.append(row);
  }

  private createFeaturedNotesNavigationButton(
    direction: "left" | "right",
    label: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-thread-card__featured-notes-nav";
    const template = document.createElement("template");
    template.innerHTML = renderToStaticMarkup(
      createElement(direction === "left" ? ChevronLeft : ChevronRight, {
        size: 16,
        strokeWidth: 2,
        "aria-hidden": true,
      }),
    );
    const icon = template.content.firstElementChild;
    if (icon) button.append(icon);
    button.setAttribute("aria-label", label);
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    return button;
  }

  private createFeaturedNoteCard(note: FeaturedNoteCard, notebookId: string): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "agent-thread-card__featured-note";
    const descriptionText = note.description.trim()
      || this.t("editor.threadCard.featuredNotes.useHint");
    card.setAttribute("aria-label", [note.title, note.name, descriptionText].filter(Boolean).join(" — "));

    const icon = document.createElement("span");
    icon.className = "agent-thread-card__featured-note-icon";
    icon.setAttribute("aria-hidden", "true");
    appendFeaturedNoteIconContent(icon, note.icon);

    const content = document.createElement("span");
    content.className = "agent-thread-card__featured-note-content";
    const title = document.createElement("span");
    title.className = "agent-thread-card__featured-note-title";
    title.textContent = note.title
      ? (note.name ? `${note.title} › ${note.name}` : note.title)
      : note.name;
    content.append(title);
    // 图标和标题并排展示; 描述保留在 aria-label 中供辅助技术读取。
    card.append(icon, content);

    card.addEventListener("click", (event) => {
      event.stopPropagation();
      // 点击 = 把这条笔记作为行内引用追加到 composer 输入框 (而不是打开笔记)。
      // 宿主未接该回调时 (例如独立的设置预览) 退化为打开笔记。
      if (this.onSelectFeaturedNote) {
        this.onSelectFeaturedNote({
          id: note.id,
          filename: note.title,
          title: note.title,
          notebookId,
          relativePath: note.id,
        });
        return;
      }
      void openNoteByNotebookPath(notebookId, note.id).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    });
    card.addEventListener("mousedown", (event) => event.stopPropagation());
    return card;
  }


}
