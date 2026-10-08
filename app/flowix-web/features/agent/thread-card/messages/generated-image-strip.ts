import { files } from "@platform/tauri/client";
import type { AppLanguage } from "@/lib/i18n";
import type { GeneratedImageSource } from "@features/agent/thread-card/messages/generated-image-results";
import {
  attachAgentMessageImagePreview,
  setAgentMessageSizedImageLoader,
} from "@features/agent/thread-card/messages/image-preview";
import { registerMessageDisposer } from "@features/agent/thread-card/messages/message-lifecycle";

const thumbnailLoaders = new WeakMap<HTMLImageElement, () => void>();

export function createGeneratedImageStrip(options: {
  id: string;
  images: GeneratedImageSource[];
  language: AppLanguage;
  getImageSpacePath?: (filePath: string) => string | null;
}): HTMLElement | null {
  if (options.images.length === 0) return null;

  const strip = document.createElement("div");
  strip.className = "agent-thread-card__generated-image-strip";
  strip.dataset.generatedImageStripId = options.id;
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", "Generated images");
  const previewObserver = typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          previewObserver?.unobserve(entry.target);
          thumbnailLoaders.get(entry.target as HTMLImageElement)?.();
        }
      }, { rootMargin: "200px" });
  const thumbnailMaxDimension = Math.min(
    480,
    Math.ceil(120 * (window.devicePixelRatio || 1)),
  );

  for (const [index, source] of options.images.entries()) {
    const frame = document.createElement("div");
    frame.className = "agent-thread-card__generated-image-frame";
    const image = document.createElement("img");
    image.className = "agent-thread-card__generated-image";
    image.alt = `Generated image ${index + 1}`;
    image.dataset.agentImagePreview = "";
    image.tabIndex = 0;
    image.setAttribute("role", "button");
    image.setAttribute("aria-haspopup", "dialog");
    image.setAttribute(
      "aria-label",
      options.language === "zh-CN" ? `预览生成图片 ${index + 1}` : `Preview generated image ${index + 1}`,
    );
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.draggable = false;
    image.addEventListener("error", () => frame.remove(), { once: true });
    frame.append(image);
    strip.append(frame);

    if (source.kind === "file") {
      const spacePath = options.getImageSpacePath?.(source.value);
      const loadPreview = (maxDimension: number) =>
        spacePath
          ? files.readImagePreview(source.value, spacePath, maxDimension).then((preview) =>
              preview ?? files.readCodexGeneratedImagePreview(source.value, maxDimension),
            )
          : files.readCodexGeneratedImagePreview(source.value, maxDimension);
      setAgentMessageSizedImageLoader(image, loadPreview);

      let previewRequested = false;
      const requestThumbnail = () => {
        if (previewRequested) return;
        previewRequested = true;
        void loadPreview(thumbnailMaxDimension).then((preview) => {
          if (preview && frame.contains(image)) image.src = preview;
          else frame.remove();
        }).catch(() => frame.remove());
      };
      thumbnailLoaders.set(image, requestThumbnail);
      if (previewObserver) previewObserver.observe(image);
      else requestThumbnail();
    } else {
      image.src = source.value;
    }
  }

  const disposeImagePreview = attachAgentMessageImagePreview(strip, options.language);
  registerMessageDisposer(strip, () => {
    disposeImagePreview?.();
    previewObserver?.disconnect();
  });

  return strip.childElementCount > 0 ? strip : null;
}
