import { cloud, listenToCloudStateChanges, product, type CloudProduct } from '@platform/tauri/client';

const CACHE_KEY_PREFIX = 'flowix.billing.products.v1';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface ProductCatalogCache {
  version: 1;
  environment: 'staging' | 'prod';
  region: 'mainland' | 'non_mainland';
  checkedAt: number;
  products: CloudProduct[];
}

let environmentPromise: Promise<ProductCatalogCache['environment']> | null = null;
let activeEnvironment: ProductCatalogCache['environment'] | null = null;
let activeRegion: ProductCatalogCache['region'] | null = null;
let memoryCache: ProductCatalogCache | null = null;
const refreshes = new Map<string, Promise<CloudProduct[]>>();

function cacheKey(
  environment: ProductCatalogCache['environment'],
  region: ProductCatalogCache['region'],
): string {
  return `${CACHE_KEY_PREFIX}.${environment}.${region}`;
}

function readCache(
  environment: ProductCatalogCache['environment'],
  region: ProductCatalogCache['region'],
): ProductCatalogCache | null {
  if (memoryCache?.environment === environment && memoryCache.region === region) return memoryCache;
  try {
    const raw = window.localStorage.getItem(cacheKey(environment, region));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object'
      || value === null
      || !('version' in value)
      || value.version !== 1
      || !('environment' in value)
      || value.environment !== environment
      || !('region' in value)
      || value.region !== region
      || !('checkedAt' in value)
      || typeof value.checkedAt !== 'number'
      || !('products' in value)
      || !Array.isArray(value.products)
    ) return null;
    memoryCache = value as ProductCatalogCache;
    return memoryCache;
  } catch {
    return null;
  }
}

async function getEnvironment(): Promise<ProductCatalogCache['environment']> {
  if (!environmentPromise) {
    if (!product?.getInfo) throw new Error('Cloud environment is unavailable');
    environmentPromise = product.getInfo().then((productInfo) => {
      activeEnvironment = productInfo.cloudEnvironment;
      if (activeRegion) memoryCache = readCache(productInfo.cloudEnvironment, activeRegion);
      return productInfo.cloudEnvironment;
    }).catch((error) => {
      environmentPromise = null;
      throw error;
    });
  }
  return environmentPromise;
}

async function getBillingRegion(): Promise<ProductCatalogCache['region']> {
  try {
    const state = await cloud.getState();
    activeRegion = state.account?.user.region === 'mainland' ? 'mainland' : 'non_mainland';
  } catch {
    activeRegion ??= 'non_mainland';
  }
  if (activeEnvironment) memoryCache = readCache(activeEnvironment, activeRegion);
  return activeRegion ?? 'non_mainland';
}

listenToCloudStateChanges?.((state) => {
  const nextRegion = state.account?.user.region === 'mainland' ? 'mainland' : 'non_mainland';
  const regionChanged = activeRegion !== nextRegion;
  activeRegion = nextRegion;
  if (activeEnvironment) memoryCache = readCache(activeEnvironment, activeRegion);
  if (regionChanged) {
    // Login, logout, or account switches can change the catalog partition.
    // Warm that region in the background so opening the dialog stays local.
    void refreshBillingProducts().catch(() => undefined);
  }
});

function writeCache(cache: ProductCatalogCache): void {
  memoryCache = cache;
  try {
    window.localStorage.setItem(cacheKey(cache.environment, cache.region), JSON.stringify(cache));
  } catch {
    // The in-memory catalog still serves this session if storage is unavailable.
  }
}

/** Read the already-resolved environment's catalog without waiting on IPC. */
export function getImmediateBillingProducts(): CloudProduct[] | null {
  if (!activeEnvironment || !activeRegion) return null;
  return readCache(activeEnvironment, activeRegion)?.products ?? null;
}

export async function getCachedBillingProducts(): Promise<CloudProduct[] | null> {
  const [environment, region] = await Promise.all([getEnvironment(), getBillingRegion()]);
  return readCache(environment, region)?.products ?? null;
}

/**
 * Fetch only when the local catalog is missing or older than one day. Calls
 * share one in-flight request per environment, including across React mounts.
 */
export async function refreshBillingProducts(force = false): Promise<CloudProduct[]> {
  const [environment, region] = await Promise.all([getEnvironment(), getBillingRegion()]);
  const cached = readCache(environment, region);
  if (!force && cached && Date.now() - cached.checkedAt < CACHE_MAX_AGE_MS) {
    return cached.products;
  }

  const key = cacheKey(environment, region);
  const existing = refreshes.get(key);
  if (existing) return existing;

  // Separate WebViews share localStorage. If another window just checked this
  // same stale catalog, keep using our copy instead of issuing a duplicate call.
  if (cached && !force) {
    try {
      const lastCheck = Number(window.localStorage.getItem(`${key}.last-check`));
      if (Number.isFinite(lastCheck) && Date.now() - lastCheck < 60_000) return cached.products;
      window.localStorage.setItem(`${key}.last-check`, String(Date.now()));
    } catch {
      // Continue with the request when storage is unavailable.
    }
  }

  const request = cloud.listProducts(region).then((products) => {
    writeCache({ version: 1, environment, region, checkedAt: Date.now(), products });
    return products;
  }).finally(() => {
    refreshes.delete(key);
  });
  refreshes.set(key, request);
  return request;
}

/**
 * Return cached products to the caller as soon as the environment is known,
 * then refresh stale data in the background. A cache miss waits for the first
 * successful catalog response so callers can show a loading or error state.
 */
export async function loadBillingProducts(
  onProducts: (products: CloudProduct[]) => void,
  force = false,
): Promise<void> {
  // Browser previews and isolated consumers may not expose desktop product
  // metadata. Keep their existing direct-fetch behavior without persisting an
  // environment-ambiguous catalog.
  if (!product?.getInfo) {
    onProducts(await cloud.listProducts());
    return;
  }

  const cached = await getCachedBillingProducts();
  if (cached) {
    onProducts(cached);
    if (force || Date.now() - (memoryCache?.checkedAt ?? 0) >= CACHE_MAX_AGE_MS) {
      void refreshBillingProducts(force).then(onProducts).catch(() => undefined);
    }
    return;
  }

  onProducts(await refreshBillingProducts(force));
}

/** Quietly warm the catalog after startup; payment UI never waits for this. */
export async function warmBillingProductCatalog(): Promise<void> {
  try {
    await refreshBillingProducts();
  } catch {
    // Opening the dialog can retry later; startup should not surface catalog errors.
  }
}
