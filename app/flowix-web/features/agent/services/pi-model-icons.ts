import { isFlowixCloudModel } from "@features/agent/config/agent-model-source";
import type { AgentModelCatalog } from "@features/agent/store/agent-data-store";

// Keep only in-flight requests: successful images use the webview's HTTP cache,
// and failed requests can be retried on a later catalog refresh.
const pending = new Map<string, HTMLImageElement>();

export function prefetchPiCloudModelIcons(catalog: AgentModelCatalog): void {
  if (typeof Image === "undefined") return;
  for (const model of catalog.items) {
    const url = model.iconUrl;
    if (!isFlowixCloudModel(model) || !url || pending.has(url)) continue;
    try {
      if (new URL(url).protocol !== "https:") continue;
    } catch { continue; }
    const image = new Image();
    pending.set(url, image);
    image.referrerPolicy = "no-referrer";
    image.onload = image.onerror = () => { pending.delete(url); };
    image.src = url;
  }
}
