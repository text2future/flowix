import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MarketUiRenderer } from './market-ui-renderer';
import { skillMarketUi } from '@platform/tauri/client';

vi.mock('@platform/tauri/client', () => ({
  skillMarketUi: { ensure: vi.fn() },
  files: { toAssetUrl: (path: string) => `asset://localhost/${encodeURIComponent(path)}` },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ language: 'zh-CN', t: (key: string) => key }) }));
vi.mock('./use-market-bridge', () => ({ useMarketBridge: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
const context = { host: 'column-1' as const, viewId: 'market', focused: true, readOnly: false };
const path = '/Users/demo/skill-market-ui/prod/versions/1.0.0/index.html';
const installedPage = { entryPath: path, cached: false };
beforeEach(() => { vi.clearAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it.each(['skills', 'templates'] as const)('shows a content spinner before preparing %s and until the iframe loads', async view => {
  let finish!: (page: { entryPath: string; cached: boolean }) => void;
  vi.mocked(skillMarketUi.ensure).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<MarketUiRenderer view={view} context={context} />));
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(host.querySelector('iframe')).toBeNull();
  await act(async () => finish(installedPage));
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const frame = host.querySelector('iframe')!;
  expect(new URL(frame.src).searchParams.get('view')).toBe(view === 'templates' ? 'templates' : null);
  await act(async () => frame.dispatchEvent(new Event('load')));
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('replaces the spinner with a retry when first download fails', async () => {
  vi.mocked(skillMarketUi.ensure).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(installedPage);
  await act(async () => root.render(<MarketUiRenderer view="skills" context={context} />));
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).toContain('页面加载失败');
  await act(async () => host.querySelector('button')!.click());
  expect(skillMarketUi.ensure).toHaveBeenCalledTimes(2);
  expect(host.querySelector('iframe')).not.toBeNull();
});

it('opens a cached page without showing a loading overlay', async () => {
  vi.mocked(skillMarketUi.ensure).mockResolvedValue({ ...installedPage, cached: true });
  await act(async () => root.render(<MarketUiRenderer view="skills" context={context} />));
  expect(host.querySelector('iframe')).not.toBeNull();
  expect(host.querySelector('[role="status"]')).toBeNull();
});
