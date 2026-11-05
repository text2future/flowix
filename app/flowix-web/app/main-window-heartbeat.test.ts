import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { HEARTBEAT_INTERVAL_MS, mountMainWindowHeartbeat } from './main-window-heartbeat';

vi.mock('@platform/tauri/client', () => ({ windows: { reportUiHeartbeat: vi.fn() } }));

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('main window heartbeat', () => {
  let report: Mock<(hidden: boolean) => Promise<void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    setVisibility('visible');
    report = vi.fn<(hidden: boolean) => Promise<void>>(async () => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports immediately and then on the shared interval', () => {
    const stop = mountMainWindowHeartbeat({ reportUiHeartbeat: report });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(report).toHaveBeenCalledTimes(3);
    stop();
  });

  it('stops while hidden and resumes with a visible beat', () => {
    const stop = mountMainWindowHeartbeat({ reportUiHeartbeat: report });
    setVisibility('hidden');
    expect(report).toHaveBeenLastCalledWith(true);
    const afterHide = report.mock.calls.length;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5);
    expect(report).toHaveBeenCalledTimes(afterHide);

    setVisibility('visible');
    expect(report).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(report.mock.calls.length).toBe(afterHide + 2);
    stop();
  });

  it('leaves no timer or listener behind after unmount', () => {
    const stop = mountMainWindowHeartbeat({ reportUiHeartbeat: report });
    stop();
    const afterStop = report.mock.calls.length;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    setVisibility('hidden');
    expect(report).toHaveBeenCalledTimes(afterStop);
  });

  it('never reports outside the desktop runtime', () => {
    vi.unstubAllGlobals();
    const stop = mountMainWindowHeartbeat({ reportUiHeartbeat: report });
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(report).not.toHaveBeenCalled();
    stop();
  });
});
