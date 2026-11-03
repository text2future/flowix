import { describe, expect, it, vi } from 'vitest';

// 每次用例都拿一份干净的模块状态 (队列/映射都在模块级)。
async function loadFacade() {
  vi.resetModules();
  return import('./toast');
}

function createRenderer() {
  const rendered: Array<{ id: number; message: string; description?: string }> = [];
  const dismissed: Array<string | number | undefined> = [];
  let nextSonnerId = 100;
  return {
    rendered,
    dismissed,
    renderer: {
      render: (request: { id: number; message: string; description?: string }) => {
        rendered.push(request);
        nextSonnerId += 1;
        return nextSonnerId;
      },
      dismiss: (id?: string | number) => {
        dismissed.push(id);
      },
    },
  };
}

describe('toast 门面', () => {
  it('渲染器就绪前先排队, 挂载后按序回放', async () => {
    const { toast, attachToastRenderer } = await loadFacade();
    const host = createRenderer();

    toast.success('第一条');
    toast.error('第二条');
    expect(host.rendered).toHaveLength(0);

    attachToastRenderer(host.renderer);
    expect(host.rendered.map((request) => request.message)).toEqual(['第一条', '第二条']);
  });

  it('渲染器就绪后立即渲染, 不再排队', async () => {
    const { toast, attachToastRenderer } = await loadFacade();
    const host = createRenderer();
    attachToastRenderer(host.renderer);

    toast.info('直接渲染');
    expect(host.rendered).toHaveLength(1);
    expect(host.rendered[0].message).toBe('直接渲染');
  });

  it('dismiss 本地 id 会映射到渲染器 id', async () => {
    const { toast, attachToastRenderer } = await loadFacade();
    const host = createRenderer();
    attachToastRenderer(host.renderer);

    const id = toast.warning('可关闭');
    toast.dismiss(id);
    expect(host.dismissed).toEqual([101]);
  });

  it('dismiss 还在队列里的 id 只从队列移除', async () => {
    const { toast, attachToastRenderer } = await loadFacade();
    const host = createRenderer();

    const id = toast.warning('排队中');
    toast.dismiss(id);
    attachToastRenderer(host.renderer);

    expect(host.rendered).toHaveLength(0);
    expect(host.dismissed).toHaveLength(0);
  });

  it('description 透传到渲染请求', async () => {
    const { toast, attachToastRenderer } = await loadFacade();
    const host = createRenderer();
    attachToastRenderer(host.renderer);

    toast.error('打开失败', { description: '权限不足' });
    expect(host.rendered[0].description).toBe('权限不足');
  });

  it('挂载请求只发一次 (宿主未就绪时连续弹多条)', async () => {
    const { toast, subscribeToastHost } = await loadFacade();
    let requests = 0;
    subscribeToastHost(() => {
      requests += 1;
    });

    toast.info('一');
    toast.info('二');
    toast.info('三');

    expect(requests).toBe(1);
  });

  it('队列超上限时丢最旧的, 不无限攒', async () => {
    const { toast, attachToastRenderer } = await loadFacade();
    const host = createRenderer();

    for (let index = 1; index <= 12; index += 1) toast.info(`第${index}条`);
    attachToastRenderer(host.renderer);

    expect(host.rendered).toHaveLength(8);
    expect(host.rendered[0].message).toBe('第5条');
    expect(host.rendered[host.rendered.length - 1].message).toBe('第12条');
  });
});
