/**
 * Guest-visible Flowix Cloud models for the Pi model picker.
 *
 * A signed-out account has no Cloud provider installed in Pi, so the native
 * catalog carries none of its models. The public catalog is what the picker
 * shows in that state: it is a preview, and a signed-out send is handled by the
 * Cloud access preflight after the prompt has entered the conversation.
 *
 * The merge lives here — the single place a Pi catalog is assembled — because
 * a plain native refresh used to overwrite the store with the local providers
 * only, which made the Cloud section appear and vanish depending on which
 * loader ran last. Every build now applies the same overlay.
 */
import { product } from "@platform/tauri/client";
import { STORAGE_KEYS } from "@/lib/constants";
import { isFlowixCloudModel } from "@features/agent/config/agent-model-source";
import type { AgentModelCatalog } from "@features/agent/store/agent-data-store";
import { FLOWIX_CLOUD_PREVIEW_PROVIDER_ID } from "@features/agent/config/cloud-access";

export type PublicCloudModel = {
  id: string;
  title?: string;
  subtitle?: string;
  creditMultiplier?: number;
  providerIconUrl?: string;
  /** Directory rank set in the Cloud admin; larger values come first. */
  sortOrder?: number;
};

export type PublicCloudCatalogCache = { fetchedAt: number; models: PublicCloudModel[] };

/**
 * Single ordering rule for every Pi model directory: larger sortOrder first,
 * unranked models count as 0. The explicit index tie-break preserves the
 * original catalog order for equal ranks without relying on sort stability.
 */
export function byModelOrder<T extends { sortOrder?: number }>(models: T[]): T[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((left, right) =>
      (right.model.sortOrder ?? 0) - (left.model.sortOrder ?? 0) || left.index - right.index)
    .map(({ model }) => model);
}

/** The public model directory changes infrequently; check it once per day. */
export const PI_PUBLIC_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function storageKey(environment: string): string {
  return `${STORAGE_KEYS.PI_CLOUD_PUBLIC_CATALOG}:${environment}`;
}

let environmentPromise: Promise<string> | null = null;

/**
 * Cloud environment the app is pointed at; `unknown` keeps the cache separable.
 *
 * Only a successful read is kept: the command is not ready during the first
 * frames, and latching that failure would pin every later read to `unknown`.
 */
export function getPiCloudEnvironment(): Promise<string> {
  environmentPromise ??= Promise.resolve()
    .then(() => product.getInfo())
    .then((info) => info.cloudEnvironment)
    .catch(() => {
      environmentPromise = null;
      return "unknown";
    });
  return environmentPromise;
}

export function readPiPublicCatalogCache(environment: string): PublicCloudCatalogCache | null {
  try {
    const value = localStorage.getItem(storageKey(environment));
    if (!value) return null;
    const parsed = JSON.parse(value) as PublicCloudCatalogCache;
    if (!Number.isFinite(parsed.fetchedAt) || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePiPublicCatalogCache(
  environment: string,
  models: PublicCloudModel[],
): void {
  try {
    localStorage.setItem(storageKey(environment), JSON.stringify({ fetchedAt: Date.now(), models }));
  } catch {
    // A full or disabled localStorage only costs the next cold start a fetch.
  }
}

/** Overlay the guest catalog on top of a local-only catalog. */
export function withPublicCloudModels(
  local: AgentModelCatalog,
  models: PublicCloudModel[],
): AgentModelCatalog {
  return {
    ...local,
    items: [...byModelOrder(models).map((model) => ({
      id: model.id,
      label: model.title?.trim() || model.id,
      source: "flowix-cloud" as const,
      providerId: FLOWIX_CLOUD_PREVIEW_PROVIDER_ID,
      providerName: "Flowix Cloud",
      subtitle: model.subtitle,
      creditMultiplier: model.creditMultiplier,
      iconUrl: model.providerIconUrl,
      sortOrder: model.sortOrder,
    })), ...local.items.filter((model) => !isFlowixCloudModel(model))],
  };
}

/**
 * Apply the cached guest catalog when the account is signed out.
 *
 * Never touches the network: it runs inside catalog assembly, so the only work
 * allowed is reading localStorage. Freshness is the caller's job — the periodic
 * sync fetches, writes the cache, and rebuilds through the loader.
 */
export async function withCachedGuestCloudModels(
  local: AgentModelCatalog,
): Promise<AgentModelCatalog> {
  const cached = readPiPublicCatalogCache(await getPiCloudEnvironment());
  return cached && cached.models.length ? withPublicCloudModels(local, cached.models) : local;
}
