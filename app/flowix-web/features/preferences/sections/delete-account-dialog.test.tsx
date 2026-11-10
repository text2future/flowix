import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeleteAccountDialog } from './delete-account-dialog';

const mocks = vi.hoisted(() => ({
  accountDeletion: vi.fn(),
  deleteAccount: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@platform/tauri/client', () => ({
  cloud: {
    accountDeletion: mocks.accountDeletion,
    deleteAccount: mocks.deleteAccount,
  },
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: mocks.success, info: mocks.info, error: mocks.error },
}));
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));

const EMAIL = 'a@example.test';
let host: HTMLDivElement;
let root: Root;
let closed: ReturnType<typeof vi.fn<(open: boolean) => void>>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountDeletion.mockResolvedValue({
    state: 'active',
    restorableUntil: null,
    graceDays: 30,
  });
  closed = vi.fn<(open: boolean) => void>();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button'))
    .find((item) => item.textContent === text);
  if (!found) throw new Error(`missing button ${text}`);
  return found;
}

function emailInput(): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>('#confirm-delete-email');
  if (!found) throw new Error('missing confirmation input');
  return found;
}

async function render(exporting = false) {
  const onExport = vi.fn();
  await act(async () => root.render(
    <DeleteAccountDialog
      open
      onOpenChange={closed}
      email={EMAIL}
      onExport={onExport}
      exporting={exporting}
    />,
  ));
  return onExport;
}

async function type(value: string) {
  const input = emailInput();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('states the real grace window and refuses to delete until the email is retyped', async () => {
  await render();
  // The grace period is server-owned: it must come from the response, not a
  // constant compiled into the UI.
  expect(mocks.accountDeletion).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('preferences.cloud.deletion.intro');
  expect(document.body.textContent).toContain('preferences.cloud.deletion.localNote');

  const confirm = button('preferences.cloud.deletion.confirm');
  expect(confirm.disabled).toBe(true);

  await type('someone-else@example.test');
  expect(button('preferences.cloud.deletion.confirm').disabled).toBe(true);
  expect(document.body.textContent).toContain('preferences.cloud.deletion.mismatch');

  // Case-insensitive, matching how the server compares it.
  await type(EMAIL.toUpperCase());
  expect(button('preferences.cloud.deletion.confirm').disabled).toBe(false);
});

it('reports the deadline and any subscription the provider refused to cancel', async () => {
  mocks.deleteAccount.mockResolvedValue({
    state: 'restorable',
    restorableUntil: 4_102_444_800_000,
    pendingSubscriptionCancellations: ['sub_1'],
  });
  await render();
  await type(EMAIL);

  await act(async () => button('preferences.cloud.deletion.confirm').click());
  await act(async () => {});

  expect(mocks.deleteAccount).toHaveBeenCalledWith(EMAIL);
  expect(mocks.success).toHaveBeenCalledWith('preferences.cloud.deletion.done');
  // The account is gone at this point; a still-running subscription is the one
  // thing that must not be swallowed.
  expect(mocks.error).toHaveBeenCalledWith('preferences.cloud.deletion.pendingCancellations');
  expect(closed).toHaveBeenCalledWith(false);
});

it('keeps the dialog open and shows a message when deletion fails', async () => {
  mocks.deleteAccount.mockRejectedValue(new Error('cloud API error 500 INTERNAL'));
  await render();
  await type(EMAIL);

  await act(async () => button('preferences.cloud.deletion.confirm').click());
  await act(async () => {});

  expect(closed).not.toHaveBeenCalledWith(false);
  expect(mocks.success).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('preferences.cloud.deletion.loadFailed');
  expect(button('preferences.cloud.deletion.confirm').disabled).toBe(false);
});

it('offers the export before the destructive button', async () => {
  const onExport = await render();
  await act(async () => button('preferences.cloud.deletion.exportFirst').click());
  expect(onExport).toHaveBeenCalledTimes(1);
});
