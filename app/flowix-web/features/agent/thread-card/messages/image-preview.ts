import type { AppLanguage } from "@/lib/i18n";

const attachedContainers = new WeakSet<HTMLElement>();
const sizedImageLoaders = new WeakMap<HTMLImageElement, (maxDimension: number) => Promise<string | null>>();

export function setAgentMessageSizedImageLoader(
  image: HTMLImageElement,
  loader: (maxDimension: number) => Promise<string | null>,
): void {
  sizedImageLoaders.set(image, loader);
}

function findPreviewImage(target: EventTarget | null, container: HTMLElement): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  const image = target.closest<HTMLImageElement>("img[data-agent-image-preview]");
  return image && container.contains(image) ? image : null;
}

function showImagePreview(image: HTMLImageElement, language: AppLanguage): void {
  const dialog = document.createElement("dialog");
  dialog.className = "agent-thread-card__image-preview";
  dialog.setAttribute("aria-label", language === "zh-CN" ? "图片预览" : "Image preview");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "agent-thread-card__image-preview-close";
  close.setAttribute("aria-label", language === "zh-CN" ? "关闭图片预览" : "Close image preview");
  close.textContent = "×";
  close.addEventListener("click", () => dialog.close());

  const preview = document.createElement("img");
  preview.className = "agent-thread-card__image-preview-image";
  preview.alt = image.alt;
  preview.decoding = "async";
  preview.draggable = false;

  const loading = document.createElement("div");
  loading.className = "agent-thread-card__image-preview-loading";
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "agent-thread-card__image-preview-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const loadingText = document.createElement("span");
  loadingText.textContent = language === "zh-CN" ? "图片加载中…" : "Loading image…";
  loading.append(spinner, loadingText);

  const loadSizedImage = sizedImageLoaders.get(image);
  const initialSource = image.currentSrc || image.src;
  let fallbackAttempted = false;
  const hideLoading = () => {
    loading.hidden = true;
  };
  preview.addEventListener("load", () => {
    preview.hidden = false;
    hideLoading();
  });
  preview.addEventListener("error", () => {
    if (initialSource && !fallbackAttempted && preview.src !== initialSource) {
      fallbackAttempted = true;
      preview.src = initialSource;
      return;
    }
    preview.hidden = true;
    hideLoading();
  });
  preview.hidden = true;

  dialog.append(close, preview, loading);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();

  const startImageLoad = () => {
    if (!dialog.open || !dialog.isConnected) return;

    if (!loadSizedImage) {
      if (initialSource) preview.src = initialSource;
      else hideLoading();
      return;
    }

    const maxDimension = Math.min(
      4096,
      Math.ceil(
        Math.max(
          Math.min(window.innerWidth * 0.94, 1600),
          window.innerHeight - 72,
        ) * window.devicePixelRatio,
      ),
    );
    void loadSizedImage(maxDimension).then((sizedSource) => {
      if (!dialog.open || !dialog.isConnected) return;
      const source = sizedSource || initialSource;
      if (source) preview.src = source;
      else hideLoading();
    }).catch(() => {
      // Fall back to the already-loaded thumbnail if the larger preview fails.
      if (!dialog.open || !dialog.isConnected) return;
      if (initialSource) preview.src = initialSource;
      else hideLoading();
    });
  };

  // Let the modal's loading state paint before assigning a potentially large
  // data URL or invoking the preview decoder.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(startImageLoad);
  });
}

/** Attach one delegated image-preview handler to a message Markdown container. */
export function attachAgentMessageImagePreview(
  container: HTMLElement,
  language: AppLanguage,
): (() => void) | undefined {
  if (attachedContainers.has(container)) return undefined;
  attachedContainers.add(container);

  const onClick = (event: MouseEvent) => {
    const image = findPreviewImage(event.target, container);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    showImagePreview(image, language);
  };
  const onMouseDown = (event: MouseEvent) => {
    if (!findPreviewImage(event.target, container)) return;
    // Avoid leaving a mouse-focused outline/selection on the thumbnail after
    // the preview closes. Keyboard focus remains available via tabindex.
    event.preventDefault();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const image = findPreviewImage(event.target, container);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    showImagePreview(image, language);
  };

  container.addEventListener("mousedown", onMouseDown);
  container.addEventListener("click", onClick);
  container.addEventListener("keydown", onKeyDown);
  return () => {
    container.removeEventListener("mousedown", onMouseDown);
    container.removeEventListener("click", onClick);
    container.removeEventListener("keydown", onKeyDown);
    attachedContainers.delete(container);
  };
}
