import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const semverIdentifier = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
const appVersionPattern = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${semverIdentifier}))?(?:\\+${semverIdentifier})?$`,
);

export interface AppUpdate {
  currentVersion: string;
  version: string;
  notify: boolean;
  date?: string;
  body?: string;
}

/** Compare strict SemVer versions; invalid versions are not considered newer. */
export function isNewerAppVersion(version: string, currentVersion: string): boolean {
  const parse = (value: string) => {
    const match = appVersionPattern.exec(value);
    if (!match) return null;
    const prerelease = match[4]?.split('.') ?? null;
    if (prerelease?.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) return null;
    return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease };
  };

  const candidate = parse(version);
  const current = parse(currentVersion);
  if (!candidate || !current) return false;

  for (let index = 0; index < 3; index += 1) {
    if (candidate.core[index] !== current.core[index]) return candidate.core[index] > current.core[index];
  }
  if (candidate.prerelease === null) return current.prerelease !== null;
  if (current.prerelease === null) return false;
  for (let index = 0; index < Math.max(candidate.prerelease.length, current.prerelease.length); index += 1) {
    const candidatePart = candidate.prerelease[index];
    const currentPart = current.prerelease[index];
    if (candidatePart === undefined) return false;
    if (currentPart === undefined) return true;
    if (candidatePart === currentPart) continue;
    const candidateNumeric = /^\d+$/.test(candidatePart);
    const currentNumeric = /^\d+$/.test(currentPart);
    if (candidateNumeric && currentNumeric) return BigInt(candidatePart) > BigInt(currentPart);
    if (candidateNumeric !== currentNumeric) return !candidateNumeric;
    return candidatePart > currentPart;
  }
  return false;
}

export interface AppUpdateInstallResult {
  status: 'success' | 'failed';
  message?: string;
}

export type AppUpdateDownloadProgress =
  | { phase: 'started'; contentLength?: number }
  | { phase: 'progress'; downloadedBytes: number; contentLength?: number }
  | { phase: 'finished'; downloadedBytes: number }
  | { phase: 'installing'; downloadedBytes: number; contentLength?: number };

let checkPromise: Promise<AppUpdate | null> | null = null;
let installPromise: Promise<void> | null = null;
let installingVersion: string | null = null;
let activeCommand: string | null = null;
let latestProgress: AppUpdateDownloadProgress | null = null;
const progressListeners = new Set<(progress: AppUpdateDownloadProgress) => void>();

function isTauriDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/**
 * Check the trusted HTTPS latest.json manifest configured for the platform.
 * Non-desktop callers deliberately return null instead of trying to call the
 * desktop updater plugin.
 */
export async function checkAppUpdate(): Promise<AppUpdate | null> {
  if (!isTauriDesktopRuntime()) return null;
  if (installPromise) throw new Error('An application update is currently being installed.');
  if (checkPromise) return checkPromise;

  const pending = (async () => {
    const update = await invoke<AppUpdate | null>('check_app_update');
    if (!update) return null;

    return {
      currentVersion: update.currentVersion,
      version: update.version,
      notify: update.notify !== false,
      date: update.date,
      body: update.body,
    };
  })();
  checkPromise = pending;
  try {
    return await pending;
  } finally {
    if (checkPromise === pending) checkPromise = null;
  }
}

export async function consumeAppUpdateResult(): Promise<AppUpdateInstallResult | null> {
  if (!isTauriDesktopRuntime()) return null;
  return await invoke<AppUpdateInstallResult | null>('consume_app_update_result');
}

export function downloadAppUpdate(
  version: string,
  onProgress?: (progress: AppUpdateDownloadProgress) => void,
): Promise<void> {
  return runPackageOperation('download_app_update', version, onProgress);
}

export function installAppUpdate(
  version: string,
  onProgress?: (progress: AppUpdateDownloadProgress) => void,
): Promise<void> {
  return runPackageOperation('install_app_update', version, onProgress);
}

async function runPackageOperation(
  command: 'download_app_update' | 'install_app_update',
  version: string,
  onProgress?: (progress: AppUpdateDownloadProgress) => void,
): Promise<void> {
  if (installPromise) {
    if (version !== installingVersion || command !== activeCommand) throw new Error('A different application update is currently being installed.');
    if (onProgress) {
      progressListeners.add(onProgress);
      if (latestProgress) onProgress(latestProgress);
    }
    try { await installPromise; }
    finally { if (onProgress) progressListeners.delete(onProgress); }
    return;
  }
  if (checkPromise) throw new Error('An application update check is currently in progress.');
  installingVersion = version;
  activeCommand = command;
  latestProgress = null;
  if (onProgress) progressListeners.add(onProgress);

  const pending = (async () => {
    const unlisten = await listen<AppUpdateDownloadProgress>('app-update-progress', (event) => {
      latestProgress = event.payload;
      for (const listener of progressListeners) listener(event.payload);
    });
    try {
      await invoke(command, { version });
      if (command === 'install_app_update') await relaunch();
    } finally {
      await unlisten();
    }
  })();
  installPromise = pending;
  try {
    await pending;
  } finally {
    if (installPromise === pending) {
      installPromise = null;
      installingVersion = null;
      activeCommand = null;
      latestProgress = null;
      progressListeners.clear();
    }
  }
}

export async function cancelAppUpdate(): Promise<boolean> {
  return await invoke<boolean>('cancel_app_update');
}

export { relaunch };
