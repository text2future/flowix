import { cloud, product, type CloudState } from "@platform/tauri/client";
import { STORAGE_KEYS } from "@/lib/constants";
import { isFlowixCloudModel } from "@features/agent/config/agent-model-source";
import { useAgentDataStore, type AgentModelCatalog } from "@features/agent/store/agent-data-store";
import { loadAgentModelCatalog, refreshAgentModelCatalog } from "./agent-catalog-service";

import { createLogger } from '@/lib/logger';
const logger = createLogger('agent/services/pi-cloud-model-service');
const pending = new Map<number, Promise<AgentModelCatalog>>();
const PUBLIC_CATALOG_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const publicCatalogRefreshInterval = setInterval(() => {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  void loadPiCloudModelCatalog({ force: true }).catch((error: unknown) => {
    logger.warn('Periodic Pi Cloud model catalog sync failed', { error });
  });
}, PUBLIC_CATALOG_SYNC_INTERVAL_MS);
publicCatalogRefreshInterval.unref?.();

type PublicCloudModel = {
  id: string;
  title?: string;
  subtitle?: string;
  creditMultiplier?: number;
  providerIconUrl?: string;
};

type PublicCloudCatalogCache = { fetchedAt: number; models: PublicCloudModel[] };

function publicCatalogStorageKey(environment: string): string {
  return `${STORAGE_KEYS.PI_CLOUD_PUBLIC_CATALOG}:${environment}`;
}

async function getCloudEnvironment(): Promise<string> {
  try {
    return (await product.getInfo()).cloudEnvironment;
  } catch (error) {
    logger.warn('Failed to read Cloud environment for Pi model cache', { error });
    return 'unknown';
  }
}

function readPublicCatalogCache(environment: string): PublicCloudCatalogCache | null {
  try {
    const value = localStorage.getItem(publicCatalogStorageKey(environment));
    if (!value) return null;
    const parsed = JSON.parse(value) as PublicCloudCatalogCache;
    if (!Number.isFinite(parsed.fetchedAt) || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch (error) {
    logger.warn('Failed to read cached Pi Cloud model catalog', { error });
    return null;
  }
}

function writePublicCatalogCache(environment: string, models: PublicCloudModel[]): void {
  try {
    localStorage.setItem(publicCatalogStorageKey(environment), JSON.stringify({ fetchedAt: Date.now(), models }));
  } catch (error) {
    logger.warn('Failed to cache Pi Cloud model catalog', { error });
  }
}

function withPublicCloudModels(local: AgentModelCatalog, models: PublicCloudModel[]): AgentModelCatalog {
  return {
    ...local,
    items: [...models.map((model) => ({
      id: model.id, label: model.title?.trim() || model.id,
      source: "flowix-cloud" as const, providerId: "__flowix-cloud-preview", providerName: "Flowix Cloud",
      subtitle: model.subtitle, creditMultiplier: model.creditMultiplier, iconUrl: model.providerIconUrl,
    })), ...local.items.filter((model) => !isFlowixCloudModel(model))],
  };
}

function applyGuestPublicCatalog(catalog: AgentModelCatalog): AgentModelCatalog {
  useAgentDataStore.getState().setModelCatalog("pi", catalog);
  return catalog;
}

function syncGuestPublicCatalog(
  local: AgentModelCatalog,
  environment: string,
  options: { force?: boolean },
  epoch: number,
): Promise<AgentModelCatalog> {
  const existing = pending.get(epoch);
  const cached = readPublicCatalogCache(environment);
  const cachedCatalog = cached ? applyGuestPublicCatalog(withPublicCloudModels(local, cached.models)) : null;
  const isFresh = cached !== null && Date.now() - cached.fetchedAt < PUBLIC_CATALOG_SYNC_INTERVAL_MS;
  if (!options.force && isFresh) return Promise.resolve(cachedCatalog ?? local);
  if (existing) return existing;

  const request = cloud.piModelCatalog().then((response) => {
    const current = useAgentDataStore.getState();
    if (current.piCloudCatalogEpoch !== epoch || current.piCloudAccountId) return current.agents.pi.catalog.models;
    writePublicCatalogCache(environment, response.data.models);
    return applyGuestPublicCatalog(withPublicCloudModels(local, response.data.models));
  }).catch((error: unknown) => {
    logger.warn('Failed to sync public Pi Cloud model catalog', { error });
    if (cachedCatalog) return cachedCatalog;
    throw error;
  }).finally(() => pending.delete(epoch));
  pending.set(epoch, request);
  return request;
}

function applyCloudState(state: CloudState): boolean {
  const store = useAgentDataStore.getState();
  if (state.revision < store.piCloudRevision) return false;
  store.setPiCloudAccount(
    state.authenticated ? state.account?.user.id ?? null : null,
    state.revision,
    state.membership,
  );
  return true;
}

/** Events and explicit snapshots use the same revision gate in the store. */
export function syncPiCloudModelCatalog(state: CloudState): Promise<AgentModelCatalog> {
  const previousEpoch = useAgentDataStore.getState().piCloudCatalogEpoch;
  const accepted = applyCloudState(state);
  const current = useAgentDataStore.getState();
  if (!accepted) {
    return Promise.resolve(current.agents.pi.catalog.models);
  }
  const sessionChanged = current.piCloudCatalogEpoch !== previousEpoch;
  if (!sessionChanged && current.agents.pi.catalog.models.items.some(isFlowixCloudModel)) {
    return Promise.resolve(current.agents.pi.catalog.models);
  }
  return ensurePiCloudModelCatalog({ force: sessionChanged });
}

/** Reconcile on opening the picker, including a missed native session event. */
export async function loadPiCloudModelCatalog(options: { force?: boolean } = {}): Promise<AgentModelCatalog> {
  try {
    const state = await cloud.getState();
    applyCloudState(state);
  } catch (error) {
    logger.warn('Failed to reconcile Cloud session before loading Pi models', { error });
  }
  return ensurePiCloudModelCatalog(options);
}

function ensurePiCloudModelCatalog(options: { force?: boolean } = {}): Promise<AgentModelCatalog> {
  const store = useAgentDataStore.getState();
  if (!store.piCloudAccountId) {
    const epoch = store.piCloudCatalogEpoch;
    return Promise.all([loadAgentModelCatalog("pi", options), getCloudEnvironment()])
      .then(([local, environment]) => syncGuestPublicCatalog(local, environment, options, epoch));
  }
  const epoch = store.piCloudCatalogEpoch;
  const existing = pending.get(epoch);
  if (existing) return existing;
  store.setPiCloudModelLoadState(epoch, { status: "loading" });
  const request = (async () => {
    const enabled = await cloud.piModelAvailability();
    const hasCloudModels = useAgentDataStore.getState().agents.pi.catalog.models.items
      .some(isFlowixCloudModel);
    if (!options.force && enabled === hasCloudModels) {
      return loadAgentModelCatalog("pi", options);
    }
    // Refresh the local catalog only when it disagrees with the global switch
    // or when the account session changed.
    const alreadyConnected = await cloud.refreshPiModelProvider();
    const connected = alreadyConnected || await cloud.refreshPiModelProviderAtStartup();
    const current = useAgentDataStore.getState();
    if (current.piCloudCatalogEpoch !== epoch) return current.agents.pi.catalog.models;
    return connected
      ? refreshAgentModelCatalog("pi")
      : loadAgentModelCatalog("pi", { force: true });
  })().then((catalog) => {
    useAgentDataStore.getState().setPiCloudModelLoadState(epoch, { status: "ready" });
    return catalog;
  }, (error: unknown) => {
    useAgentDataStore.getState().setPiCloudModelLoadState(epoch, {
      status: "error", error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }).finally(() => pending.delete(epoch));
  pending.set(epoch, request);
  return request;
}
