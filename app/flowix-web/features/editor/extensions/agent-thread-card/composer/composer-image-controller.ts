import { agent, type CachedAgentImage } from "@platform/tauri/client";

export type AgentThreadCardInputImage = CachedAgentImage;

const MAX_COMPOSER_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_COMPOSER_IMAGE_COUNT = 5;

export interface ComposerImageControllerOptions {
  input: HTMLTextAreaElement;
  container: HTMLElement;
  initialImages: AgentThreadCardInputImage[];
  onChange: (images: AgentThreadCardInputImage[]) => void;
  onStateChange: () => void;
  onError: (message: string) => void;
  onLimitExceeded: (kind: "count" | "size") => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

export class ComposerImageController {
  private images: AgentThreadCardInputImage[];
  private readonly previews = new Map<string, string>();
  private pending = 0;
  private disposed = false;

  constructor(private readonly options: ComposerImageControllerOptions) {
    this.images = options.initialImages.slice(0, MAX_COMPOSER_IMAGE_COUNT);
    options.input.addEventListener("paste", this.handlePaste);
    this.render();
    for (const image of this.images) void this.loadPreview(image);
  }

  get readyImages(): AgentThreadCardInputImage[] {
    return [...this.images];
  }

  get hasImages(): boolean {
    return this.images.length > 0;
  }

  get hasPending(): boolean {
    return this.pending > 0;
  }

  clearAfterSubmit(): void {
    this.images = [];
    this.previews.clear();
    this.options.onChange([]);
    this.render();
    this.options.onStateChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.input.removeEventListener("paste", this.handlePaste);
    this.options.container.replaceChildren();
    this.previews.clear();
  }

  private readonly handlePaste = (event: ClipboardEvent): void => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length === 0) return;

    // Clipboard image payloads often also contain a generated filename as text.
    // Prevent that text from being inserted; genuine text-only paste stays native.
    event.preventDefault();
    const eligibleFiles = files.filter((file) => {
      if (file.size <= MAX_COMPOSER_IMAGE_BYTES) return true;
      this.options.onLimitExceeded("size");
      return false;
    });
    const availableSlots = Math.max(
      0,
      MAX_COMPOSER_IMAGE_COUNT - this.images.length - this.pending,
    );
    if (eligibleFiles.length > availableSlots) {
      this.options.onLimitExceeded("count");
    }
    for (const file of eligibleFiles.slice(0, availableSlots)) {
      void this.cache(file);
    }
  };

  private async cache(file: File): Promise<void> {
    this.pending += 1;
    this.options.onStateChange();
    try {
      const content = await readFileAsDataUrl(file);
      const cached = await agent.cacheImage(content, file.type);
      if (this.disposed) {
        void agent.deleteCachedImage(cached.path).catch(() => undefined);
        return;
      }
      this.previews.set(cached.path, content);
      this.images = [...this.images, cached];
      this.options.onChange(this.readyImages);
      this.render();
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.pending = Math.max(0, this.pending - 1);
      this.options.onStateChange();
    }
  }

  private remove(
    image: AgentThreadCardInputImage,
    deleteCachedFile: boolean = true,
  ): void {
    this.images = this.images.filter((candidate) => candidate.path !== image.path);
    this.previews.delete(image.path);
    this.options.onChange(this.readyImages);
    this.render();
    this.options.onStateChange();
    if (deleteCachedFile) {
      void agent.deleteCachedImage(image.path).catch(() => undefined);
    }
  }

  private async loadPreview(image: AgentThreadCardInputImage): Promise<void> {
    try {
      const content = await agent.readCachedImage(image.path);
      if (this.disposed) return;
      if (!content) {
        this.remove(image, false);
        return;
      }
      if (!this.images.some((candidate) => candidate.path === image.path)) return;
      this.previews.set(image.path, content);
      this.render();
    } catch (error) {
      if (!this.disposed) {
        this.options.onError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private render(): void {
    const cards = this.images.map((image) => {
      const card = document.createElement("span");
      card.className = "agent-thread-card__composer-image";

      const previewUrl = this.previews.get(image.path);
      const preview = previewUrl ? document.createElement("img") : null;
      if (preview && previewUrl) {
        preview.src = previewUrl;
        preview.alt = image.name;
        preview.draggable = false;
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "agent-thread-card__composer-image-remove";
      remove.setAttribute("aria-label", "Remove image");
      remove.textContent = "×";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.remove(image);
      });
      if (preview) card.append(preview);
      card.append(remove);
      return card;
    });
    this.options.container.replaceChildren(...cards);
    this.options.container.hidden = cards.length === 0;
    this.options.container.parentElement?.classList.toggle(
      "agent-thread-card__composer--has-images",
      cards.length > 0,
    );
  }
}
