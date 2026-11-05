import type { I18nKey } from '@/lib/i18n';
import { resolveNoteThumbnailSrc } from '@/lib/note-thumbnail';

export interface NoteReferencePreviewData {
  title: string;
  preview: string;
  thumbnail: string | null;
  notebookId: string;
  relativePath: string;
  notebookPath: string;
  filePath: string;
}

interface NoteReferencePreviewControllerOptions {
  anchor: HTMLElement;
  getLocatorKey: () => string;
  getFallbackTitle: () => string;
  loadData: () => Promise<NoteReferencePreviewData | null>;
  openNote: (data: NoteReferencePreviewData) => Promise<void>;
  t: (key: I18nKey) => string;
  onError: (error: unknown) => void;
}

/** 缩略图可能是文档相对路径，按被引用笔记自身的绝对路径解析。 */
function noteReferenceThumbnailUrl(data: NoteReferencePreviewData): string | null {
  return resolveNoteThumbnailSrc(data.thumbnail, data.filePath);
}

/** Owns the composer note-reference preview's DOM, async lifecycle, and placement. */
export class NoteReferencePreviewController {
  private popover: HTMLDivElement | null = null;
  private title: HTMLElement | null = null;
  private text: HTMLElement | null = null;
  private image: HTMLImageElement | null = null;
  private openButton: HTMLButtonElement | null = null;
  private isOpen = false;
  private isDisposed = false;
  private requestId = 0;
  private cache: { key: string; promise: Promise<NoteReferencePreviewData | null> } | null = null;

  constructor(private readonly options: NoteReferencePreviewControllerOptions) {}

  toggle(): void {
    if (this.isDisposed) return;
    if (this.isOpen) this.close();
    else this.show();
  }

  invalidate(): void {
    this.cache = null;
    if (this.isOpen) this.loadAndRender();
  }

  /** Keep the replacement trigger in sync when its inline-atom DOM is rebuilt. */
  syncAnchorState(): void {
    this.options.anchor
      .querySelector<HTMLElement>('[data-inline-atom-card]')
      ?.setAttribute('aria-expanded', String(this.isOpen));
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.close();
    this.popover?.remove();
    this.popover = null;
  }

  private ensurePopover(): void {
    if (this.popover) return;

    const popover = document.createElement('div');
    popover.className = 'agent-composer__note-reference-preview';
    popover.hidden = true;
    popover.setAttribute('role', 'dialog');

    const image = document.createElement('img');
    image.className = 'agent-composer__note-reference-preview-image';
    image.alt = '';
    image.draggable = false;
    image.hidden = true;
    image.addEventListener('load', this.position);
    image.addEventListener('error', () => {
      image.hidden = true;
      this.position();
    });

    const body = document.createElement('div');
    body.className = 'agent-composer__note-reference-preview-body';
    const titleRow = document.createElement('div');
    titleRow.className = 'agent-composer__note-reference-preview-title-row';
    const title = document.createElement('div');
    title.className = 'agent-composer__note-reference-preview-title';
    const text = document.createElement('div');
    text.className = 'agent-composer__note-reference-preview-text';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'agent-composer__note-reference-preview-open';
    openButton.textContent = this.options.t('editor.noteLink.openNote');
    openButton.addEventListener('mousedown', (event) => event.preventDefault());
    openButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openReferencedNote();
    });

    titleRow.append(title, openButton);
    body.append(titleRow, text);
    popover.append(image, body);
    document.body.append(popover);

    this.popover = popover;
    this.title = title;
    this.text = text;
    this.image = image;
    this.openButton = openButton;
  }

  private show(): void {
    this.ensurePopover();
    if (!this.popover || this.isDisposed) return;

    this.isOpen = true;
    this.popover.hidden = false;
    this.options.anchor
      .querySelector<HTMLElement>('[data-inline-atom-card]')
      ?.setAttribute('aria-expanded', 'true');
    window.addEventListener('resize', this.position);
    window.addEventListener('scroll', this.position, true);
    document.addEventListener('pointerdown', this.handleOutsidePointer, true);
    document.addEventListener('keydown', this.handleKeyDown, true);
    this.position();
    this.loadAndRender();
  }

  private close(): void {
    this.isOpen = false;
    this.requestId += 1;
    if (this.popover) this.popover.hidden = true;
    this.options.anchor
      .querySelector<HTMLElement>('[data-inline-atom-card]')
      ?.setAttribute('aria-expanded', 'false');
    window.removeEventListener('resize', this.position);
    window.removeEventListener('scroll', this.position, true);
    document.removeEventListener('pointerdown', this.handleOutsidePointer, true);
    document.removeEventListener('keydown', this.handleKeyDown, true);
  }

  private handleOutsidePointer = (event: PointerEvent): void => {
    const target = event.target;
    if (
      target instanceof Node &&
      (this.options.anchor.contains(target) || this.popover?.contains(target))
    ) return;
    this.close();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.isOpen) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  private loadCachedData(): Promise<NoteReferencePreviewData | null> {
    const key = this.options.getLocatorKey();
    if (this.cache?.key === key) return this.cache.promise;

    const promise = this.options.loadData().catch((error: unknown) => {
      if (this.cache?.key === key) this.cache = null;
      throw error;
    });
    this.cache = { key, promise };
    return promise;
  }

  private loadAndRender(): void {
    if (!this.isOpen || !this.text || !this.openButton || !this.popover) return;
    const requestId = ++this.requestId;
    this.title!.textContent = this.options.getFallbackTitle();
    this.popover.setAttribute('aria-label', this.title!.textContent ?? '');
    this.text.textContent = this.options.t('editor.noteLink.previewLoading');
    this.openButton.disabled = true;
    if (this.image) this.image.hidden = true;
    this.position();

    void this.loadCachedData().then((data) => {
      if (this.isDisposed || !this.isOpen || requestId !== this.requestId) return;
      if (!data) {
        this.text!.textContent = this.options.t('editor.noteLink.previewUnavailable');
        this.openButton!.disabled = true;
      } else {
        this.title!.textContent = data.title;
        this.popover!.setAttribute('aria-label', data.title);
        this.text!.textContent = data.preview.trim()
          || this.options.t('editor.noteLink.previewEmpty');
        this.openButton!.disabled = false;
        const thumbnailUrl = noteReferenceThumbnailUrl(data);
        if (thumbnailUrl && this.image) {
          this.image.hidden = false;
          if (this.image.src !== thumbnailUrl) this.image.src = thumbnailUrl;
        }
      }
      this.position();
    }).catch(() => {
      if (this.isDisposed || !this.isOpen || requestId !== this.requestId) return;
      this.text!.textContent = this.options.t('editor.noteLink.previewUnavailable');
      this.openButton!.disabled = true;
      this.position();
    });
  }

  private position = (): void => {
    if (!this.isOpen || !this.popover?.isConnected || !this.options.anchor.isConnected) return;
    const anchorRect = this.options.anchor.getBoundingClientRect();
    const popoverRect = this.popover.getBoundingClientRect();
    const width = popoverRect.width || 304;
    const height = popoverRect.height || 156;
    const padding = 8;
    const left = Math.min(
      Math.max(anchorRect.left + (anchorRect.width - width) / 2, padding),
      Math.max(padding, window.innerWidth - width - padding),
    );
    const preferredTop = anchorRect.top - height - 8;
    const top = preferredTop >= padding
      ? preferredTop
      : Math.min(anchorRect.bottom + 8, Math.max(padding, window.innerHeight - height - padding));
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  };

  private async openReferencedNote(): Promise<void> {
    const button = this.openButton;
    if (!button || button.disabled || this.isDisposed) return;
    const locatorKey = this.options.getLocatorKey();
    button.disabled = true;
    try {
      const data = await this.loadCachedData();
      // The inline atom may have been edited while the preview request was in
      // flight. Never navigate using data for the previous target.
      if (locatorKey !== this.options.getLocatorKey()) return;
      if (!data) throw new Error(this.options.t('editor.noteLink.previewUnavailable'));
      await this.options.openNote(data);
      this.close();
    } catch (error) {
      this.options.onError(error);
    } finally {
      if (
        !this.isDisposed
        && button.isConnected
        && locatorKey === this.options.getLocatorKey()
      ) button.disabled = false;
    }
  }
}
