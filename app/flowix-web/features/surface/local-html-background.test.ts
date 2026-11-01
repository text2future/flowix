import { afterEach, expect, it, vi } from 'vitest';
import bridgeSource from '../../../flowix-desktop/src/local_html_preview.js?raw';

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
  document.body.removeAttribute('class');
  document.querySelector('[data-background-test]')?.remove();
});

it('composites computed page colors, follows stylesheet/theme changes and stops after unload', async () => {
  const doc = document;
  vi.spyOn(doc, 'readyState', 'get').mockReturnValue('complete');
  doc.documentElement.style.backgroundColor = '#112233';
  const stylesheet = doc.createElement('style');
  stylesheet.setAttribute('data-background-test', '');
  stylesheet.textContent = 'body.dark { background-color: rgba(0, 0, 0, 0.5); }';
  doc.head.append(stylesheet);
  const fills: string[] = [];
  let pixel = [17, 34, 51, 255];
  const context = {
    fillStyle: '',
    clearRect: vi.fn(),
    fillRect: vi.fn(() => fills.push(context.fillStyle)),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(pixel) })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const parent = { postMessage: vi.fn() };
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const scheme = new EventTarget();
  const frame = Object.assign(new EventTarget(), {
    parent,
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver,
    matchMedia: () => scheme,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const flush = () => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  };
  const messages = () => parent.postMessage.mock.calls.filter(([data]) => data.type === 'flowix:local-html-background');
  new Function('window', 'document', 'location', bridgeSource)(frame, doc, { href: 'asset://localhost/book/index.html' });
  flush();
  // Transparent body falls back to the root, both composited over iframe white.
  expect(fills).toEqual(['#ffffff', 'rgb(17, 34, 51)', 'rgba(0, 0, 0, 0)']);
  expect(messages()).toEqual([[{
    type: 'flowix:local-html-background', url: 'asset://localhost/book/index.html', color: 'rgb(17, 34, 51)',
  }, '*']]);
  fills.length = 0;
  pixel = [8, 17, 25, 255];
  doc.body.className = 'dark';
  await Promise.resolve();
  flush();
  expect(fills).toEqual(['#ffffff', 'rgb(17, 34, 51)', 'rgba(0, 0, 0, 0.5)']);
  expect(messages().slice(-1)[0]?.[0].color).toBe('rgb(8, 17, 25)');
  scheme.dispatchEvent(new Event('change'));
  flush();
  expect(messages()).toHaveLength(2);
  pixel = [255, 255, 255, 255];
  stylesheet.textContent = 'body.dark { background-color: white; }';
  await Promise.resolve();
  flush();
  expect(messages().slice(-1)[0]?.[0].color).toBe('rgb(255, 255, 255)');
  frame.dispatchEvent(new Event('resize'));
  expect(frames.size).toBe(1);
  frame.dispatchEvent(new Event('pagehide'));
  expect(frames.size).toBe(0);
  doc.body.style.backgroundColor = 'red';
  await Promise.resolve();
  frame.dispatchEvent(new Event('resize'));
  scheme.dispatchEvent(new Event('change'));
  expect(frames.size).toBe(0);
});
