import { expect, it, vi } from 'vitest';
import { observeFrontmatterView } from './frontmatter-view-lifecycle';

const releases = vi.hoisted(() => [vi.fn(), vi.fn(), vi.fn()]);
vi.mock('@features/preferences/public/runtime-api', () => ({
  subscribeAppLanguage: () => releases[0], subscribePropertyFieldPreferences: () => releases[1],
}));
vi.mock('@/lib/store/settings-store', () => ({ useSettingsStore: { subscribe: () => releases[2] } }));

it('releases every external listener and subscription exactly once on destruction', () => {
  const handlers = { render: vi.fn(), pointerDown: vi.fn(), selectStart: vi.fn(), addProperty: vi.fn(),
    occupiedKeys: vi.fn(), pointerMove: vi.fn(), pointerUp: vi.fn(), pointerCancel: vi.fn(), blur: vi.fn() };
  const dispose = observeFrontmatterView(document, handlers);
  document.dispatchEvent(new Event('pointerdown'));
  window.dispatchEvent(new Event('flowix:add-property'));
  window.dispatchEvent(new Event('flowix:query-occupied-property-keys'));
  expect(handlers.pointerDown).toHaveBeenCalledOnce();
  expect(handlers.addProperty).toHaveBeenCalledOnce();
  expect(handlers.occupiedKeys).toHaveBeenCalledOnce();
  dispose();
  dispose();
  document.dispatchEvent(new Event('pointerdown'));
  window.dispatchEvent(new Event('flowix:add-property'));
  window.dispatchEvent(new Event('flowix:query-occupied-property-keys'));
  expect(handlers.pointerDown).toHaveBeenCalledOnce();
  expect(handlers.addProperty).toHaveBeenCalledOnce();
  expect(handlers.occupiedKeys).toHaveBeenCalledOnce();
  for (const release of releases) expect(release).toHaveBeenCalledOnce();
});
