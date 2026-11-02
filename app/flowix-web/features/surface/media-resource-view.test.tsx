import { SessionViewRecoveryContext, createSessionViewChannel } from '@features/workspace/public/session-view-state-api';
import { useWorkspaceSessionStore } from '@features/workspace/store/workspace-session-store';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import { MediaResourceView } from './media-resource-view';

const mocks = vi.hoisted(() => ({ readImage: vi.fn(), toAssetUrl: vi.fn(), mediaGet: vi.fn(), cancelThumbnail: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({
  files: { readImage: mocks.readImage, toAssetUrl: mocks.toAssetUrl },
  mediaResources: { get: mocks.mediaGet, cancelThumbnail: mocks.cancelThumbnail },
}));
vi.mock('./video-preview-cache', () => ({ getNotebookVideoPreview: vi.fn().mockResolvedValue(null) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;
let updates: SurfacePresentationUpdate[];
const reportPresentation = (update: SurfacePresentationUpdate) => updates.push(update);

function latestState() {
  const stateUpdates = updates.filter((update) => update.state);
  return stateUpdates[stateUpdates.length - 1]?.state;
}

async function render(filePath: string) {
  await act(async () => root.render(<MediaResourceView filePath={filePath} notebookPath="/book" resourceKind="image" reportPresentation={reportPresentation} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelThumbnail.mockResolvedValue(undefined);
  host = document.createElement('div');
  root = createRoot(host);
  updates = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe('media resource presentation', () => {
  it('publishes loading, error, retry and ready after the image is loaded', async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    mocks.readImage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render('/book/photo.png');
    expect(latestState()?.status).toBe('loading');

    await act(async () => first.reject(new Error('read failed')));
    expect(latestState()?.status).toBe('error');
    const errorState = latestState();
    const retry = errorState && (errorState.status === 'error' || errorState.status === 'unavailable')
      ? errorState.actions?.find((action) => action.id === 'retry')
      : undefined;
    expect(retry).toBeDefined();
    await act(async () => retry?.run());
    await act(async () => second.resolve('data:image/png;base64,abc'));

    const image = host.querySelector('img');
    expect(image).not.toBeNull();
    await act(async () => image!.dispatchEvent(new Event('load')));
    expect(latestState()?.status).toBe('ready');
    expect(mocks.readImage).toHaveBeenCalledTimes(2);
  });

  it('ignores an image read that finishes after switching to another file', async () => {
    const stale = deferred<string | null>();
    const current = deferred<string | null>();
    mocks.readImage.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    await render('/book/old.png');
    await render('/book/new.png');

    await act(async () => stale.resolve('data:image/png;base64,old'));
    expect(host.querySelector('img')).toBeNull();
    await act(async () => current.resolve('data:image/png;base64,new'));
    expect(host.querySelector('img')?.alt).toBe('new.png');
    expect(updates.some((update) => update.title === 'old.png' && update.state?.status === 'ready')).toBe(false);
  });
});


describe('media session recovery', () => {
  it('restores metadata only after video authorization and metadata are ready', async () => {
    useWorkspaceSessionStore.getState().reset();
    useWorkspaceSessionStore.getState().commitTarget('secondary-session', { kind: 'external', path: '/book/video.mp4', scopePath: '/book', transitionId: null });
    const entryId = useWorkspaceSessionStore.getState().sessions['secondary-session'].navigation.current!.id;
    const channel = createSessionViewChannel('secondary-session', entryId, 'video:/book/video.mp4');
    const saved = { kind: 'media' as const, currentTime: 30, volume: 0.4, muted: true, playbackRate: 1.5 };
    channel.write(saved);
    mocks.mediaGet.mockResolvedValue({}); mocks.toAssetUrl.mockReturnValue('asset://video');
    const renderVideo = () => <SessionViewRecoveryContext.Provider value={{ sessionId: 'secondary-session', entryId }}>
      <MediaResourceView filePath="/book/video.mp4" notebookPath="/book" resourceKind="video" />
    </SessionViewRecoveryContext.Provider>;
    await act(async () => root.render(renderVideo()));
    const video = host.querySelector('video')!;
    expect(video.currentTime).toBe(0);
    Object.defineProperty(video, 'duration', { configurable: true, value: 20 });
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
    expect(video.currentTime).toBe(20); expect(video.volume).toBe(0.4);
    expect(video.muted).toBe(true); expect(video.playbackRate).toBe(1.5);
    expect(video.paused).toBe(true);
    video.currentTime = 12;
    await act(async () => root.render(null));
    expect(channel.read()).toEqual({ ...saved, currentTime: 12 });
  });

  it('preserves saved progress if the video is unmounted before metadata loads', async () => {
    useWorkspaceSessionStore.getState().reset();
    useWorkspaceSessionStore.getState().commitTarget('primary-session', { kind: 'external', path: '/book/video.mp4', scopePath: '/book', transitionId: null });
    const entryId = useWorkspaceSessionStore.getState().sessions['primary-session'].navigation.current!.id;
    const channel = createSessionViewChannel('primary-session', entryId, 'video:/book/video.mp4');
    const saved = { kind: 'media' as const, currentTime: 80, volume: 0.8, muted: false, playbackRate: 1 };
    channel.write(saved); mocks.mediaGet.mockResolvedValue({});
    await act(async () => root.render(<SessionViewRecoveryContext.Provider value={{ sessionId: 'primary-session', entryId }}>
      <MediaResourceView filePath="/book/video.mp4" notebookPath="/book" resourceKind="video" />
    </SessionViewRecoveryContext.Provider>));
    expect(host.querySelector('video')).not.toBeNull();
    await act(async () => root.render(null));
    expect(channel.read()).toEqual(saved);
  });
});
