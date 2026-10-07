import type { I18nKey, I18nParams } from '@/lib/i18n';
import { notes as notesClient, files, externalDocuments } from '@platform/tauri/client';
import { openNoteByNotebookPath } from '@features/memo/use-cases/open-by-target';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import { parseTableDocumentAsync } from '@features/multidimensional-table/parse-table-document';
import { toast } from '@/lib/toast';
import { applyPopoverPosition, calculateAnchoredPopoverPosition } from '../popover/popover-position';
import {
  FEATURED_NOTE_MOBILE_PAGE_SIZE,
  FEATURED_NOTE_PAGE_SIZE,
  appendFeaturedNoteIconContent,
  getFeaturedNotePage,
  getFeaturedNotePageCountForSize,
  getFeaturedPathNoteCards,
  readFeaturedNotesTableSelection,
  writeFeaturedNotesTableSelection,
  type FeaturedNoteCard,
  type FeaturedNotesTableSelection,
} from "@features/agent/thread-card/settings/featured-note-cards";

const FEATURED_NOTES_MOBILE_QUERY = "(max-width: 767px)";
const FEATURED_NOTES_VIEW_PICKER_WIDTH_PX = 272;
const FEATURED_NOTES_VIEW_PICKER_PADDING_PX = 8;
interface FeaturedNotesOptions {
  getNotebookId: () => string | null;
  t: (key: I18nKey, params?: I18nParams) => string;
  isDestroyed: () => boolean;
  onSelectFeaturedNote?: (ref: { id: string; filename: string; title: string; notebookId?: string; relativePath?: string }) => void;
}

/** Owns note queries, filtering UI and its detached popover lifecycle. */
export class FeaturedNotesController {
  private featuredNotesRequestId = 0;
  private featuredNotesViewportCleanup: (() => void) | null = null;
  private disposed = false;
  constructor(private readonly options: FeaturedNotesOptions) {}
  private getCurrentNotebookId = () => this.options.getNotebookId();
  private t = (key: I18nKey, params?: I18nParams) => this.options.t(key, params);
  private isDestroyed = () => this.disposed || this.options.isDestroyed();
  private get onSelectFeaturedNote() { return this.options.onSelectFeaturedNote; }
  dispose(): void {
    this.disposed = true;
    this.featuredNotesRequestId += 1;
    this.featuredNotesViewportCleanup?.();
  }

  async appendFeaturedNotes(empty: HTMLElement): Promise<void> {
    const notebookId = this.getCurrentNotebookId();
    if (!notebookId) return;

    this.featuredNotesViewportCleanup?.();
    empty.querySelector(".agent-thread-card__featured-notes")?.remove();
    const requestId = ++this.featuredNotesRequestId;
    const selection = await readFeaturedNotesTableSelection(notebookId);
    if (this.isDestroyed() || requestId !== this.featuredNotesRequestId) return;
    try {
      const indexed = await notesClient.list(notebookId);
      const notes = selection
        ? getFeaturedPathNoteCards(await this.loadSelectedTableNotes(notebookId, selection, indexed), null)
        : [];
      if (this.isDestroyed() || requestId !== this.featuredNotesRequestId || !empty.isConnected) return;

      let panel: HTMLElement;
      panel = this.createFeaturedNotesElement(notes, selection, notebookId, () => {
        panel.remove();
        void this.appendFeaturedNotes(empty);
      });
      empty.append(panel);
    } catch {
      // Featured notes are an enhancement to the empty state. A failed or
      // unavailable memo query must never block starting a conversation.
    }
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
    return table.records.data.flatMap((record) => {
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

    let currentPage = 0;
    const mobileQuery = window.matchMedia(FEATURED_NOTES_MOBILE_QUERY);
    const getPageSize = (): number => mobileQuery.matches
      ? FEATURED_NOTE_MOBILE_PAGE_SIZE
      : FEATURED_NOTE_PAGE_SIZE;

    const navigation = document.createElement("div");
    navigation.className = "agent-thread-card__featured-notes-navigation";
    const previousButton = this.createFeaturedNotesNavigationButton(
      "‹",
      this.t("editor.threadCard.featuredNotes.previous"),
    );
    const nextButton = this.createFeaturedNotesNavigationButton(
      "›",
      this.t("editor.threadCard.featuredNotes.next"),
    );
    navigation.append(previousButton, nextButton);
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "agent-thread-card__featured-notes-settings-button";
    settingsButton.textContent = this.t("editor.threadCard.featuredNotes.settings");
    settingsButton.setAttribute("aria-expanded", "false");
    const settingsFooter = document.createElement("div");
    settingsFooter.className = "agent-thread-card__featured-notes-settings-footer";
    settingsFooter.append(settingsButton, navigation);

    const settingsPopover = this.createTableSelectionPopover(notebookId, selection, onFilterChange, () => {
      settingsPopover.hidden = true;
      settingsButton.setAttribute("aria-expanded", "false");
      settingsButton.focus();
    });
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
    const setSettingsOpen = (open: boolean): void => {
      settingsPopover.hidden = !open;
      settingsButton.setAttribute("aria-expanded", String(open));
      if (open) {
        positionSettingsPopover();
        (settingsPopover.querySelector<HTMLElement>(".agent-thread-card__featured-notes-view-option")
          ?? settingsPopover.querySelector<HTMLElement>(".agent-thread-card__featured-notes-view-create"))?.focus();
      }
      else settingsButton.focus();
    };
    settingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setSettingsOpen(settingsButton.getAttribute("aria-expanded") !== "true");
    });

    const list = document.createElement("div");
    list.className = "agent-thread-card__featured-notes-list";
    panel.append(list);
    panel.append(settingsFooter);

    const renderPage = (): void => {
      const pageSize = getPageSize();
      const pageCount = getFeaturedNotePageCountForSize(notes.length, pageSize);
      currentPage = Math.min(currentPage, pageCount - 1);
      const pageNotes = getFeaturedNotePage(notes, currentPage, pageSize);
      list.replaceChildren();
      list.dataset.cardCount = String(pageNotes.length);
      for (const note of pageNotes) {
        list.append(this.createFeaturedNoteCard(note, notebookId));
      }
      previousButton.disabled = currentPage === 0;
      nextButton.disabled = currentPage >= pageCount - 1;
      previousButton.hidden = pageCount <= 1;
      nextButton.hidden = pageCount <= 1;
    };

    previousButton.addEventListener("click", (event) => {
      event.stopPropagation();
      currentPage = Math.max(0, currentPage - 1);
      renderPage();
    });
    nextButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const pageCount = getFeaturedNotePageCountForSize(notes.length, getPageSize());
      currentPage = Math.min(pageCount - 1, currentPage + 1);
      renderPage();
    });
    const handleViewportChange = (): void => renderPage();
    const handleWindowResize = (): void => positionSettingsPopover();
    const handleOutsidePointer = (event: PointerEvent): void => {
      // 下拉层单独挂在 body, 点击内容区不关闭; 点击其他位置关闭。
      const target = event.target as Node;
      if (panel.contains(target) || settingsPopover.contains(target)) return;
      setSettingsOpen(false);
    };
    const handleEscape = (event: KeyboardEvent): void => {
      if (settingsPopover.hidden) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSettingsOpen(false);
    };
    mobileQuery.addEventListener("change", handleViewportChange);
    window.addEventListener("resize", handleWindowResize);
    document.addEventListener("pointerdown", handleOutsidePointer);
    document.addEventListener("keydown", handleEscape);
    this.featuredNotesViewportCleanup = () => {
      mobileQuery.removeEventListener("change", handleViewportChange);
      popoverResizeObserver.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      document.removeEventListener("pointerdown", handleOutsidePointer);
      document.removeEventListener("keydown", handleEscape);
      // 弹层挂在 document.body 上, 不随 panel 一起被移除, 必须显式清理,
      // 否则每次刷新精选笔记都会在 body 里留下一个孤儿弹层。
      settingsPopover.remove();
      this.featuredNotesViewportCleanup = null;
    };
    renderPage();
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
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              await writeFeaturedNotesTableSelection(notebookId, entry.selection);
              onChange();
            } catch { button.disabled = false; toast.error(this.t("editor.threadCard.featuredNotes.saveFailed")); }
          });
          items.append(button);
        }
        status.remove();
      } catch {
        status.textContent = this.t("editor.threadCard.featuredNotes.noTables");
      }
    })();
    return popover;
  }

  private appendCreateTableAction(container: HTMLElement, notebookId: string, onChange: () => void, onCreateTable: () => void): void {
    const create = document.createElement("button");
    create.type = "button";
    create.className = "flex h-8 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-white text-sm text-gray-900 hover:bg-gray-100 disabled:opacity-50";
    create.textContent = this.t("editor.threadCard.featuredNotes.createTable");
    create.addEventListener("click", async () => {
      onCreateTable();
      const notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
      if (!notebook || notebook.missing) return;
      const request = new CustomEvent("flowix:open-create-table-dialog", {
        cancelable: true,
        detail: {
          notebookId,
          onCreated: async (selection: FeaturedNotesTableSelection) => {
            await files.setTableDocumentInViews(notebookId, selection.collectionId, true);
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
    text: string,
    label: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-thread-card__featured-notes-nav";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    return button;
  }

  private createFeaturedNoteCard(note: FeaturedNoteCard, notebookId: string): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "agent-thread-card__featured-note";
    card.setAttribute("aria-label", [note.name, note.title, note.description].filter(Boolean).join(" — "));

    const icon = document.createElement("span");
    icon.className = "agent-thread-card__featured-note-icon";
    icon.setAttribute("aria-hidden", "true");
    appendFeaturedNoteIconContent(icon, note.icon);

    const content = document.createElement("span");
    content.className = "agent-thread-card__featured-note-content";
    const title = document.createElement("span");
    title.className = "agent-thread-card__featured-note-title";
    title.textContent = note.name ? `${note.name} › ${note.title}` : note.title;
    const description = document.createElement("span");
    description.className = "agent-thread-card__featured-note-description";
    description.textContent = note.description;
    content.append(title, description);
    // 图标独占首行 (原先这一行右侧还有个「试试」按钮, 已移除)。
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
