import type { AppLanguage } from "@/lib/i18n";

const attachedContainers = new WeakSet<HTMLElement>();
const sizedImageLoaders = new WeakMap<HTMLElement, (maxDimension: number) => Promise<string | null>>();
const previewSources = new WeakMap<HTMLElement, string>();

export function setAgentMessageImagePreviewSource(
  trigger: HTMLElement,
  source: string,
): void {
  previewSources.set(trigger, source);
}

export function setAgentMessageSizedImageLoader(
  image: HTMLElement,
  loader: (maxDimension: number) => Promise<string | null>,
): void {
  sizedImageLoaders.set(image, loader);
}

function findPreviewTrigger(target: EventTarget | null, container: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const trigger = target.closest<HTMLElement>("[data-agent-image-preview]");
  return trigger && container.contains(trigger) ? trigger : null;
}

function getTriggerSource(trigger: HTMLElement): string {
  const explicitSource = previewSources.get(trigger);
  if (explicitSource) return explicitSource;
  return trigger instanceof HTMLImageElement
    ? trigger.currentSrc || trigger.src
    : "";
}

function getTriggerAlt(trigger: HTMLElement): string {
  return trigger instanceof HTMLImageElement
    ? trigger.alt
    : trigger.dataset.agentImageAlt ?? trigger.getAttribute("aria-label") ?? "Image";
}

function showImagePreview(trigger: HTMLElement, language: AppLanguage): void {
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
  preview.alt = getTriggerAlt(trigger);
  preview.decoding = "async";
  preview.draggable = false;

  const loading = document.createElement("div");
  loading.className = "agent-thread-card__image-preview-loading";
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "agent-thread-card__image-preview-spinner flowix-spin";
  spinner.setAttribute("aria-hidden", "true");
  const loadingText = document.createElement("span");
  loadingText.textContent = language === "zh-CN" ? "图片加载中…" : "Loading image…";
  loading.append(spinner, loadingText);

  const loadSizedImage = sizedImageLoaders.get(trigger);
  const initialSource = getTriggerSource(trigger);
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
    const trigger = findPreviewTrigger(event.target, container);
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    showImagePreview(trigger, language);
  };
  const onMouseDown = (event: MouseEvent) => {
    if (!findPreviewTrigger(event.target, container)) return;
    // Avoid leaving a mouse-focused outline/selection on the thumbnail after
    // the preview closes. Keyboard focus remains available via tabindex.
    event.preventDefault();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const trigger = findPreviewTrigger(event.target, container);
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    showImagePreview(trigger, language);
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
