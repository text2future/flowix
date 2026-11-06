import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { openSkillMarketUi } from '@features/surface/public/open-skill-market-ui';
import { NotebookMoreSection } from './notebook-more-section';

vi.mock('@features/surface/public/open-skill-market-ui', () => ({ openSkillMarketUi: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
afterEach(() => { vi.clearAllMocks(); document.body.innerHTML = ''; });

it('opens each market view without putting loading on sidebar items', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<NotebookMoreSection order={0} onHeightChange={() => {}} />));
    const buttons = host.querySelectorAll('button');
    await act(async () => buttons[1].click());
    expect(openSkillMarketUi).toHaveBeenLastCalledWith('skills');
    await act(async () => buttons[2].click());
    expect(openSkillMarketUi).toHaveBeenLastCalledWith('templates');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[2].disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
