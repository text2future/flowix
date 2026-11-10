import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PiCloudModelsSection } from './pi-cloud-models-section';

const mocks = vi.hoisted(() => ({
  getAiCreditBalance: vi.fn(),
  refreshPiModelProvider: vi.fn(),
  refreshAgentModelCatalog: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@platform/tauri/client', () => ({
  cloud: {
    getAiCreditBalance: mocks.getAiCreditBalance,
    refreshPiModelProvider: mocks.refreshPiModelProvider,
  },
}));
vi.mock('@features/agent/services/agent-catalog-service', () => ({
  refreshAgentModelCatalog: mocks.refreshAgentModelCatalog,
}));
vi.mock('@/lib/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock('@/lib/toast', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAiCreditBalance.mockResolvedValue({
    balanceMicrocredits: 1_000_000,
    monthlyBalanceMicrocredits: 500_000,
    permanentBalanceMicrocredits: 500_000,
    monthlyExpiresAt: null,
  });
  mocks.refreshPiModelProvider.mockResolvedValue(true);
  mocks.refreshAgentModelCatalog.mockResolvedValue({ items: [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('refreshes the Cloud model catalog before reloading the local Pi catalog', async () => {
  await act(async () => root.render(<PiCloudModelsSection authenticated />));
  const refreshButton = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.includes('preferences.pi.cloudCreditsRefresh'),
  );
  expect(refreshButton).toBeDefined();

  await act(async () => refreshButton!.click());

  expect(mocks.refreshPiModelProvider).toHaveBeenCalledOnce();
  expect(mocks.refreshAgentModelCatalog).toHaveBeenCalledWith('pi');
  expect(mocks.refreshPiModelProvider.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.refreshAgentModelCatalog.mock.invocationCallOrder[0]);
  expect(mocks.getAiCreditBalance).toHaveBeenCalledTimes(2);
});
