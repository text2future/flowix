import { cloud, type CloudState } from "@platform/tauri/client";
import { isFlowixCloudModel } from "@features/agent/config/agent-model-source";
import { useAgentDataStore, type AgentModelCatalog } from "@features/agent/store/agent-data-store";
import { loadAgentModelCatalog, refreshAgentModelCatalog } from "./agent-catalog-service";
import {
  PI_PUBLIC_CATALOG_MAX_AGE_MS,
  getPiCloudEnvironment,
  readPiPublicCatalogCache,
  withPublicCloudModels,
  writePiPublicCatalogCache,
} from "./pi-public-catalog";

import { createLogger } from '@/lib/logger';
const logger = createLogger('agent/services/pi-cloud-model-service');
const pending = new Map<number, Promise<AgentModelCatalog>>();
const publicCatalogRefreshInterval = setInterval(() => {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  void loadPiCloudModelCatalog({ force: true }).catch((error: unknown) => {
    logger.warn('Periodic Pi Cloud model catalog sync failed', { error });
  });
}, PI_PUBLIC_CATALOG_MAX_AGE_MS);
publicCatalogRefreshInterval.unref?.();

/**
 * Refresh the guest catalog, then rebuild through the shared loader.
 *
 * The overlay itself lives in `agent-catalog-service` so that any refresh —
 * including one triggered outside this service — keeps the Cloud section.
 * Here we only own the network fetch and the cache it feeds.
 */
function syncGuestPublicCatalog(
  environment: string,
  options: { force?: boolean },
  epoch: number,
): Promise<AgentModelCatalog> {
  const existing = pending.get(epoch);
  const cached = readPiPublicCatalogCache(environment);
  const isFresh = cached !== null && Date.now() - cached.fetchedAt < PI_PUBLIC_CATALOG_MAX_AGE_MS;
  if (!options.force && isFresh) return loadAgentModelCatalog("pi", options);
  if (existing) return existing;

  const request = cloud.piModelCatalog().then(async (response) => {
    const current = useAgentDataStore.getState();
    if (current.piCloudCatalogEpoch !== epoch || current.piCloudAccountId) {
      return current.agents.pi.catalog.models;
    }
    writePiPublicCatalogCache(environment, response.data.models);
    // Rebuild through the loader so the store matches what every other path
    // produces, then re-apply the fetched list: the cache write can fail, and
    // this response is newer than whatever the loader read.
    const local = await loadAgentModelCatalog("pi", { force: true });
    // Signing in during that rebuild moves the conversation to the member
    // catalog; a guest overlay would then hide the real Cloud models.
    const store = useAgentDataStore.getState();
    if (store.piCloudCatalogEpoch !== epoch || store.piCloudAccountId) {
      return store.agents.pi.catalog.models;
    }
    const catalog = withPublicCloudModels(local, response.data.models);
    store.setModelCatalog("pi", catalog);
    return catalog;
  }).catch((error: unknown) => {
    logger.warn('Failed to sync public Pi Cloud model catalog', { error });
    if (cached) return loadAgentModelCatalog("pi", options);
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
    return getPiCloudEnvironment()
      .then((environment) => syncGuestPublicCatalog(environment, options, epoch));
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
