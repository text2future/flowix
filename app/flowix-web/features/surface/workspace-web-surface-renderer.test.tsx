import { useSessionWebRuntimeStore } from '@features/workspace/public/session-web-api';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebRenderer } from './workspace-web-surface-renderer';
import { createWorkspaceWebRuntime } from '@features/workspace/model/web-navigation';
import type { WorkspaceWebNavigationPort } from './workspace-surface-renderer-contract';

vi.mock('@platform/tauri/opener', () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@shared/ui/web-frame-scrollbar', () => ({ connectWebFrameScrollbar: vi.fn(() => () => {}) }));

let root: Root;
let host: HTMLDivElement;
const url = 'https://example.com/';

beforeEach(() => {
  useSessionWebRuntimeStore.setState({ runtimes: {} });
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function navigate(address: string) {
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, address);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

async function click(label: string) {
  await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(); });
}

describe('shared web renderer', () => {
  it('provides navigation, history and reload in Work without Browser state', async () => {
    await act(async () => root.render(<WebRenderer surface={{ kind: 'web', url }} context={{ host: 'main-third', viewId: 'work-web', focused: true, readOnly: false }} />));
    await navigate('https://example.org/next');
    expect(host.querySelector('iframe')!.src).toBe('https://example.org/next');
    await click('后退');
    expect(host.querySelector('iframe')!.src).toBe(url);
    await click('前进');
    expect(host.querySelector('iframe')!.src).toBe('https://example.org/next');
    const frame = host.querySelector('iframe');
    await click('重新加载');
    expect(host.querySelector('iframe')).not.toBe(frame);
  });

  it('delegates Browser navigation to the injected tab port', async () => {
    const runtime = { ...createWorkspaceWebRuntime(url), history: ['https://before.com/', url, 'https://after.com/'], historyIndex: 1 };
    const port: WorkspaceWebNavigationPort = {
      getRuntime: vi.fn(() => runtime), setRuntime: vi.fn(), navigate: vi.fn(), back: vi.fn(),
      forward: vi.fn(), reload: vi.fn(), updateMetadata: vi.fn(),
    };
    await act(async () => root.render(<WebRenderer surface={{ kind: 'web', url, runtime }} context={{ host: 'browser-column', viewId: 'tab-web', focused: true, readOnly: false, webNavigation: port }} />));
    await click('后退'); await click('前进'); await click('重新加载');
    await navigate('https://example.org/');
    expect(port.back).toHaveBeenCalledOnce();
    expect(port.forward).toHaveBeenCalledOnce();
    expect(port.reload).toHaveBeenCalledOnce();
    expect(port.navigate).toHaveBeenCalledWith('https://example.org/');
    expect(port.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({ title: 'example.org' }));
  });

  it('clears the timeout after a cross-origin iframe load', async () => {
    await act(async () => root.render(<WebRenderer surface={{ kind: 'web', url }} context={{ host: 'main-third', viewId: 'work-web', focused: true, readOnly: false }} />));
    const frame = host.querySelector('iframe')!;
    Object.defineProperty(frame, 'contentWindow', { get: () => { throw new DOMException('Cross origin', 'SecurityError'); } });
    await act(async () => { frame.dispatchEvent(new Event('load')); vi.advanceTimersByTime(6000); });
    expect(host.textContent).not.toContain('网页可能禁止嵌入或加载超时');
  });
});

it('retains the mounted iframe and current page when only the container geometry changes', async () => {
  const render = (column: number) => root.render(
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
      <section style={{ gridColumn: column }}>
        <WebRenderer surface={{ kind: 'web', url }} context={{
          host: 'main-third', viewId: 'relocatable-web', focused: true, readOnly: false,
        }} />
      </section>
    </div>,
  );
  await act(async () => render(1));
  await navigate('https://retained.example/');
  const iframe = host.querySelector('iframe');
  expect(iframe?.getAttribute('src')).toBe('https://retained.example/');
  await act(async () => render(2));
  expect(host.querySelector('iframe')).toBe(iframe);
  expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://retained.example/');
});
