import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PiCloudModelsSection } from './pi-cloud-models-section';

const mocks = vi.hoisted(() => ({
  getAiCreditBalance: vi.fn(),
  refreshPiModelProvider: vi.fn(),
  refreshPiModelProviderAtStartup: vi.fn(),
  refreshAgentModelCatalog: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const loadedCredits = {
  data: { balanceMicrocredits: 1_000_000, monthlyBalanceMicrocredits: 500_000,
    permanentBalanceMicrocredits: 500_000, monthlyExpiresAt: null },
  status: 'ready' as const, error: null, updatedAt: 1,
};

vi.mock('@platform/tauri/client', () => ({
  cloud: {
    getAiCreditBalance: mocks.getAiCreditBalance,
    refreshPiModelProvider: mocks.refreshPiModelProvider,
    refreshPiModelProviderAtStartup: mocks.refreshPiModelProviderAtStartup,
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
  mocks.refreshPiModelProviderAtStartup.mockResolvedValue(true);
  mocks.refreshAgentModelCatalog.mockResolvedValue({ items: [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

it('creates the Cloud provider when refreshing for the first time', async () => {
  mocks.refreshPiModelProvider.mockResolvedValue(false);
  await act(async () => root.render(<PiCloudModelsSection authenticated />));
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="preferences.pi.cloudCreditsRefresh"]');
  await act(async () => button!.click());
  expect(mocks.refreshPiModelProviderAtStartup).toHaveBeenCalledOnce();
  expect(mocks.refreshPiModelProviderAtStartup.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.refreshAgentModelCatalog.mock.invocationCallOrder[0]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('refreshes the Cloud model catalog before reloading the local Pi catalog', async () => {
  await act(async () => root.render(<PiCloudModelsSection authenticated />));
  const refreshButton = Array.from(container.querySelectorAll('button')).find(
    (button) => button.getAttribute('aria-label') === 'preferences.pi.cloudCreditsRefresh',
  );
  expect(refreshButton).toBeDefined();

  await act(async () => refreshButton!.click());

  expect(mocks.refreshPiModelProvider).toHaveBeenCalledOnce();
  expect(mocks.refreshAgentModelCatalog).toHaveBeenCalledWith('pi');
  expect(mocks.refreshPiModelProvider.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.refreshAgentModelCatalog.mock.invocationCallOrder[0]);
  expect(mocks.getAiCreditBalance).toHaveBeenCalledTimes(2);
});

it('shows spendable credits even when the AI membership is inactive', async () => {
  await act(async () => root.render(<PiCloudModelsSection authenticated membershipStatus="inactive" aiCredits={loadedCredits} />));
  expect(container.textContent).toContain('1.00');
  expect(container.textContent).toContain('0.50');
});

it('displays a shared snapshot while refreshing, then the updated balance', async () => {
  await act(async () => root.render(<PiCloudModelsSection authenticated aiCredits={{ ...loadedCredits, status: 'refreshing' }} />));
  expect(container.textContent).toContain('1.00');
  expect(container.textContent).toContain('preferences.cloud.membershipLoading');
  await act(async () => root.render(<PiCloudModelsSection authenticated aiCredits={{ ...loadedCredits,
    data: { ...loadedCredits.data, balanceMicrocredits: 7_000_000 } }} />));
  expect(mocks.getAiCreditBalance).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('7.00');
});

it('does not show a previous balance as current after a failed refresh', async () => {
  await act(async () => root.render(<PiCloudModelsSection authenticated aiCredits={loadedCredits} />));
  await act(async () => root.render(<PiCloudModelsSection authenticated aiCredits={{
    data: null, status: 'error', error: 'offline', updatedAt: null,
  }} />));
  expect(container.textContent).not.toContain('1.00');
  expect(container.textContent).toContain('preferences.pi.cloudCreditsUnavailable');
});
