import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCollectionBannerControl, useCollectionBannerControl } from './collection-banner-visibility';

const INDEX = '/book/客户周报/.index.yaml';
const disposers: Array<() => void> = [];
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  // 注册表是模块级单例：每个用例自己摘干净，避免互相干扰。
  await act(async () => { while (disposers.length > 0) disposers.pop()?.(); });
});

/** 用一个小探针读 hook 的返回值：`available:visible`。 */
function Probe({ indexPath }: { indexPath: string }) {
  const { available, visible, toggle } = useCollectionBannerControl(indexPath);
  return <button type="button" onClick={toggle}>{`${available}:${visible}`}</button>;
}

async function renderProbe(indexPath = INDEX): Promise<HTMLButtonElement> {
  const node = document.createElement('div');
  root = createRoot(node);
  await act(async () => root?.render(<Probe indexPath={indexPath} />));
  return node.querySelector('button')!;
}

function register(control: { visible: boolean; toggle: () => void }): void {
  disposers.push(registerCollectionBannerControl(INDEX, control));
}

describe('collection banner control bridge', () => {
  it('没有外壳登记时 available=false（菜单据此不显示「显示头图」）', async () => {
    expect((await renderProbe()).textContent).toBe('false:false');
  });

  it('登记后读到 visible，点击走外壳给的开关', async () => {
    const toggle = vi.fn();
    await act(async () => register({ visible: true, toggle }));
    const probe = await renderProbe();
    expect(probe.textContent).toBe('true:true');
    await act(async () => probe.click());
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('摘下登记项后回到没有入口的状态', async () => {
    await act(async () => register({ visible: true, toggle: vi.fn() }));
    const probe = await renderProbe();
    expect(probe.textContent).toBe('true:true');
    await act(async () => { disposers.pop()?.(); });
    expect(probe.textContent).toBe('false:false');
  });

  it('同一集合开在多处时取最后登记的写入口，摘除后回落到前一个', async () => {
    const first = vi.fn();
    const second = vi.fn();
    await act(async () => register({ visible: true, toggle: first }));
    await act(async () => register({ visible: false, toggle: second }));

    const probe = await renderProbe();
    expect(probe.textContent).toBe('true:false');
    await act(async () => probe.click());
    expect(second).toHaveBeenCalledOnce();

    await act(async () => { disposers.pop()?.(); });
    expect(probe.textContent).toBe('true:true');
  });
});
