import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAppUpdater } from '../hooks/use-app-updater';
import { useAppUpdaterStore } from './app-updater-store';
import type { AppUpdateDownloadProgress } from '@platform/tauri/client/updater';
const mocks = vi.hoisted(() => ({ check: vi.fn(), download: vi.fn(), install: vi.fn(), cancel: vi.fn() }));
vi.mock('@platform/tauri/client/updater', () => ({checkAppUpdate:mocks.check, downloadAppUpdate:mocks.download, installAppUpdate:mocks.install, cancelAppUpdate:mocks.cancel}));
vi.mock('@/lib/startup-stage3', () => ({
  waitForStartupStage3: async () => {},
  runStartupStage3Task: async (_name: string, task: () => Promise<void>) => task(),
}));
const update = {currentVersion:'1.0.0', version:'1.1.0', notify:true};
function deferred<T>() {
  let resolve!: (value:T) => void;
  let reject!: (error:unknown) => void;
  const promise = new Promise<T>((done, fail) => {resolve=done;reject=fail;});
  return {promise,resolve,reject};
}
const roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  useAppUpdaterStore.setState({status:'idle',update:null,progress:null,error:null,checkStarted:false});
  mocks.check.mockResolvedValue(update);
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  vi.useRealTimers();
});
it('shares check results and live install progress with a newly mounted entry point', async () => {
  const check = deferred<typeof update>();
  mocks.check.mockReturnValue(check.promise);
  const snapshots: string[] = [];
  function Entry() { const state=useAppUpdater(); snapshots.push(`${state.status}:${state.progress?.phase ?? ''}`); return null; }
  const first=createRoot(document.createElement('div')); roots.push(first);
  await act(async () => first.render(<Entry />));
  let pending!: Promise<unknown>;
  await act(async () => {pending=useAppUpdaterStore.getState().checkNow();});
  expect(useAppUpdaterStore.getState().checkNow()).toBe(pending);
  await act(async () => {check.resolve(update);await pending;});
  const install=deferred<void>();
  let progress!: (value:AppUpdateDownloadProgress) => void;
  mocks.install.mockImplementation((_version, callback) => {progress=callback;return install.promise;});
  await act(async () => {pending=useAppUpdaterStore.getState().installNow();});
  expect(useAppUpdaterStore.getState().installNow()).toBe(pending);
  await act(async () => progress({phase:'progress',downloadedBytes:10,contentLength:20}));
  const second=createRoot(document.createElement('div')); roots.push(second);
  await act(async () => second.render(<Entry />));
  expect(snapshots[snapshots.length - 1]).toBe('downloading:progress');
  await expect(useAppUpdaterStore.getState().checkNow()).rejects.toThrow('being installed');
  expect(useAppUpdaterStore.getState().status).toBe('downloading');
  await act(async () => {install.resolve(); await pending;});
  expect(mocks.install).toHaveBeenCalledTimes(1);
});
it('keeps installing state when native cancellation is refused', async () => {
  await useAppUpdaterStore.getState().checkNow();
  const install=deferred<void>();
  mocks.install.mockImplementation((_version, progress) => {progress({phase:'installing',downloadedBytes:20});return install.promise;});
  const pending=useAppUpdaterStore.getState().installNow();
  await Promise.resolve();
  mocks.cancel.mockResolvedValue(false);
  await useAppUpdaterStore.getState().cancelNow();
  expect(useAppUpdaterStore.getState().status).toBe('installing');
  install.resolve(); await pending;
});
it('waits for accepted cancellation to release the operation before allowing retry', async () => {
  await useAppUpdaterStore.getState().checkNow();
  const install=deferred<void>();
  mocks.install.mockReturnValue(install.promise);
  const pending=useAppUpdaterStore.getState().installNow();
  const rejection=expect(pending).rejects.toThrow('cancelled');
  await Promise.resolve();
  mocks.cancel.mockResolvedValue(true);
  const cancelled=useAppUpdaterStore.getState().cancelNow();
  await Promise.resolve();
  expect(useAppUpdaterStore.getState().status).toBe('downloading');
  install.reject(new Error('application update cancelled'));
  await cancelled; await rejection;
  expect(useAppUpdaterStore.getState()).toMatchObject({status:'available',error:null,progress:null});
});
it('releases failed checks so a later manual check can succeed', async () => {
  mocks.check.mockRejectedValueOnce(new Error('request timed out'));
  await expect(useAppUpdaterStore.getState().checkNow()).rejects.toThrow('timed out');
  expect(useAppUpdaterStore.getState().update).toBeNull();
  await useAppUpdaterStore.getState().checkNow();
  expect(useAppUpdaterStore.getState().status).toBe('available');
});
it('runs one silent automatic check across entries and allows manual retry after failure', async () => {
  vi.useFakeTimers();
  mocks.check.mockRejectedValueOnce(new Error('automatic check timed out'));
  function Entry() { useAppUpdater({autoCheck:true,delayMs:10}); return null; }
  for (let i=0;i<2;i++) {
    const root=createRoot(document.createElement('div')); roots.push(root);
    await act(async () => root.render(<Entry />));
  }
  await act(async () => {await vi.advanceTimersByTimeAsync(10);});
  expect(mocks.check).toHaveBeenCalledTimes(1);
  expect(useAppUpdaterStore.getState()).toMatchObject({status:'error',update:null});
  await act(async () => {await useAppUpdaterStore.getState().checkNow();});
  expect(useAppUpdaterStore.getState().status).toBe('available');
});

it('manual checking does not download; download progress ends ready without installing', async () => {
  await useAppUpdaterStore.getState().checkNow();
  expect(mocks.download).not.toHaveBeenCalled();
  const download = deferred<void>();
  mocks.download.mockImplementation((_version, progress) => {
    progress({phase:'progress', downloadedBytes:10, contentLength:20});
    return download.promise;
  });
  const pending = useAppUpdaterStore.getState().downloadNow();
  expect(useAppUpdaterStore.getState().downloadNow()).toBe(pending);
  await Promise.resolve();
  expect(useAppUpdaterStore.getState()).toMatchObject({status:'downloading',progress:{downloadedBytes:10}});
  download.resolve(); await pending;
  expect(useAppUpdaterStore.getState().status).toBe('ready');
  expect(mocks.install).not.toHaveBeenCalled();
  await useAppUpdaterStore.getState().checkNow();
  expect(useAppUpdaterStore.getState().status).toBe('ready');
  await useAppUpdaterStore.getState().installNow();
  expect(mocks.install).toHaveBeenCalledTimes(1);
});
it('retains discovered update after a failed download and allows retry', async () => {
  await useAppUpdaterStore.getState().checkNow();
  mocks.download.mockRejectedValueOnce(new Error('download failed'));
  await expect(useAppUpdaterStore.getState().downloadNow()).rejects.toThrow('download failed');
  expect(useAppUpdaterStore.getState()).toMatchObject({status:'available',update});
  await useAppUpdaterStore.getState().downloadNow();
  expect(useAppUpdaterStore.getState().status).toBe('ready');
});
it('automatically checks without downloading', async () => {
  vi.useFakeTimers();
  function Entry() {useAppUpdater({autoCheck:true,delayMs:10});return null;}
  const root=createRoot(document.createElement('div')); roots.push(root);
  await act(async () => root.render(<Entry />));
  await act(async () => {await vi.advanceTimersByTimeAsync(10);});
  expect(mocks.check).toHaveBeenCalledTimes(1);
  expect(mocks.download).not.toHaveBeenCalled();
  expect(useAppUpdaterStore.getState().status).toBe('available');
  expect(mocks.install).not.toHaveBeenCalled();
});
it('does not automatically download releases with notifications disabled', async () => {
  vi.useFakeTimers();
  mocks.check.mockResolvedValue({...update,notify:false});
  function Entry() {useAppUpdater({autoCheck:true,delayMs:10});return null;}
  const root=createRoot(document.createElement('div')); roots.push(root);
  await act(async () => root.render(<Entry />));
  await act(async () => {await vi.advanceTimersByTimeAsync(10);});
  expect(mocks.download).not.toHaveBeenCalled();
});
