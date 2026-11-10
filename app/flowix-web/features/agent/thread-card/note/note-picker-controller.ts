import type { I18nKey, I18nParams } from '@/lib/i18n';
import { replayEnterAnimation } from '@/lib/replay-enter-animation';
import { notes as notesClient } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { createAnchoredPopoverController, type AnchoredPopoverController } from '../anchored-popover-controller';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';

const SEARCH_LIMIT = 10;
const SEARCH_DELAY_MS = 150;

export interface MemoRef {
  id?: string;
  filename: string;
  title: string;
  notebookId?: string;
  relativePath?: string;
}

interface NoteHit extends MemoRef {
  notebookId: string;
  relativePath: string;
  notebookName: string;
}

export interface NotePickerControllerOptions {
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  t: (key: I18nKey, params?: I18nParams) => string;
  isDestroyed: () => boolean;
  injectMemoReference: (ref: MemoRef) => void;
  onSelect?: () => void;
}

export class NotePickerController {
  private open = false;
  private disposed = false;
  private query = '';
  private hits: NoteHit[] = [];
  private loading = false;
  private composing = false;
  private requestSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private submenuAnchor: HTMLElement | null = null;
  private readonly positionController: AnchoredPopoverController;

  constructor(private readonly options: NotePickerControllerOptions) {
    this.positionController = createAnchoredPopoverController({
      isOpen: () => this.open,
      isDestroyed: options.isDestroyed,
      isHidden: () => options.popover.hidden,
      position: () => this.position(),
      observe: () => [options.trigger, options.popover],
    });
  }

  get popoverElement(): HTMLDivElement { return this.options.popover; }

  openFromParent(anchor: HTMLElement): void {
    this.submenuAnchor = anchor;
    this.setOpen(true);
    this.positionController.schedule();
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.options.popover.hidden = !open;
    if (open) {
      replayEnterAnimation(this.options.popover);
      this.query = '';
      this.composing = false;
      this.hits = [];
      this.render();
      this.search('');
      this.positionController.start();
      this.positionController.schedule();
      document.addEventListener('pointerdown', this.onOutsidePointer, true);
    } else {
      this.submenuAnchor = null;
      this.cancelSearch();
      this.positionController.stop();
      document.removeEventListener('pointerdown', this.onOutsidePointer, true);
    }
  }

  refresh(): void { if (this.open) this.render(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setOpen(false);
    this.positionController.dispose();
    this.options.popover.remove();
  }

  private onOutsidePointer = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (target && (this.options.popover.contains(target) || this.options.trigger.contains(target))) return;
    this.setOpen(false);
  };

  private cancelSearch(): void {
    this.requestSeq++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private search(query: string): void {
    this.cancelSearch();
    const seq = this.requestSeq;
    this.hits = [];
    this.loading = true;
    this.renderResults();
    this.timer = setTimeout(() => {
      this.timer = null;
      const notebooks = useNoteStore.getState().notebooks;
      void Promise.allSettled(notebooks.map(async (notebook): Promise<NoteHit[]> => {
        const notes = await notesClient.search(notebook.id, query.trim(), SEARCH_LIMIT);
        return notes.map((note) => ({
          notebookId: notebook.id,
          notebookName: notebook.name,
          relativePath: note.relativePath,
          filename: note.relativePath.split('/').pop() || note.relativePath,
          title: note.title,
        }));
      })).then((results) => {
        if (this.disposed || this.options.isDestroyed() || !this.open || seq !== this.requestSeq) return;
        const groups = results.map((result) => result.status === 'fulfilled' ? result.value : []);
        const hits: NoteHit[] = [];
        for (let rank = 0; hits.length < SEARCH_LIMIT && groups.some((group) => rank < group.length); rank++) {
          for (const group of groups) {
            if (group[rank]) hits.push(group[rank]);
            if (hits.length === SEARCH_LIMIT) break;
          }
        }
        this.hits = hits;
        this.loading = false;
        this.renderResults();
      });
    }, SEARCH_DELAY_MS);
  }

  private render(): void {
    const list = document.createElement('div');
    list.className = 'agent-composer__note-search-list';
    list.dataset.noteResults = '';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'agent-composer__note-search';
    search.placeholder = this.options.t('editor.threadCard.noteSearch.searchPlaceholder');
    search.setAttribute('aria-label', this.options.t('editor.threadCard.noteSearch.sectionTitle'));
    search.value = this.query;
    search.addEventListener('input', (event) => {
      if (this.composing || (event as InputEvent).isComposing) return;
      this.query = search.value;
      this.search(this.query);
    });
    search.addEventListener('compositionstart', () => { this.composing = true; this.cancelSearch(); });
    search.addEventListener('compositionend', () => {
      this.composing = false;
      this.query = search.value;
      this.search(this.query);
    });
    const handleNavigation = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.setOpen(false); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
        const items = Array.from(list.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Enter') (items[current] ?? items[0]).click();
        else items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    search.addEventListener('keydown', handleNavigation);
    list.addEventListener('keydown', handleNavigation);
    const divider = document.createElement('div');
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-hidden', 'true');
    divider.className = POPUP_SEPARATOR_CLASS;
    this.options.popover.replaceChildren(list, divider, search);
    this.renderResults();
    requestAnimationFrame(() => { if (this.open && !this.disposed) search.focus(); });
  }

  private renderResults(): void {
    const list = this.options.popover.querySelector<HTMLElement>('[data-note-results]');
    if (!list) return;
    list.replaceChildren();
    const header = document.createElement('div');
    header.className = 'agent-composer__note-popover-header';
    const title = document.createElement('div');
    title.className = 'agent-composer__note-popover-title';
    title.textContent = this.options.t('editor.threadCard.noteSearch.sectionTitle');
    header.append(title);
    list.append(header);
    const filter = this.query.trim().toLocaleLowerCase();
    const hits = this.hits.filter((note) => !filter || [note.title, note.filename, note.notebookName].some((value) => value.toLocaleLowerCase().includes(filter)));
    for (const note of hits) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'agent-composer__note-result agent-composer__note-item';
      item.title = `${note.title} · ${note.notebookName}`;
      item.textContent = note.title || note.filename;
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        this.options.injectMemoReference(note);
        this.setOpen(false);
        this.options.onSelect?.();
      });
      list.append(item);
    }
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'agent-composer__note-empty';
      empty.textContent = this.loading
        ? this.options.t('editor.threadCard.noteSearch.searching')
        : this.options.t(filter ? 'editor.threadCard.noteSearch.emptyNoMatch' : 'editor.threadCard.noteSearch.emptyHint');
      list.append(empty);
    }
    this.positionController.schedule();
  }

  private position(): void {
    const { trigger, popover } = this.options;
    if (!this.open || !trigger.isConnected || !popover.isConnected) return;
    const rect = (this.submenuAnchor ?? trigger).getBoundingClientRect();
    const width = popover.getBoundingClientRect().width || 300;
    const height = popover.getBoundingClientRect().height || 360;
    const padding = 8;
    const left = rect.right + width + padding <= window.innerWidth
      ? rect.right + 2
      : Math.max(padding, rect.left - width - 2);
    const top = Math.max(padding, Math.min(rect.top, window.innerHeight - height - padding));
    Object.assign(popover.style, { left: `${left}px`, top: `${top}px` });
  }
}
