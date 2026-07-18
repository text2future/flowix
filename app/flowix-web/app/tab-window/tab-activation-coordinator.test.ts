import { describe, expect, it } from 'vitest';
import { TabActivationCoordinator } from './tab-activation-coordinator';

describe('TabActivationCoordinator', () => {
  it('runs only the latest request queued in the same turn', async () => {
    const coordinator = new TabActivationCoordinator();
    const calls: string[] = [];
    const task = async (tabId: string) => {
      calls.push(tabId);
      return true;
    };

    const first = coordinator.request('a', task);
    const second = coordinator.request('b', task);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(calls).toEqual(['b']);
  });

  it('drops an intermediate request while current work is in flight', async () => {
    const coordinator = new TabActivationCoordinator();
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = coordinator.request('a', async (tabId, isLatest) => {
      calls.push(tabId);
      await gate;
      return isLatest();
    });
    await Promise.resolve();
    const middle = coordinator.request('b', async (tabId) => {
      calls.push(tabId);
      return true;
    });
    const last = coordinator.request('c', async (tabId) => {
      calls.push(tabId);
      return true;
    });
    release();

    await expect(first).resolves.toBe(false);
    await expect(middle).resolves.toBe(false);
    await expect(last).resolves.toBe(true);
    await expect(coordinator.waitForIdle()).resolves.toBe(true);
    expect(calls).toEqual(['a', 'c']);
  });
});
