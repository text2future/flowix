import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useAutoContentColumnWidths, type AutoColumnContent } from './use-auto-content-column-widths';

it('reuses text measurements across appended batches and measures edited values', async () => {
  const measureText = vi.fn((text: string) => ({ width: text.length * 10 }));
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText, font: '' } as unknown as CanvasRenderingContext2D);
  let columns: AutoColumnContent[];
  function StableProbe() {
    const ref = useRef<HTMLTableElement>(null);
    const widths = useAutoContentColumnWidths(ref, columns);
    return <div><table ref={ref} data-width={widths.title} /></div>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (values: string[]) => {
    columns = [{ id: 'title', label: 'Title', type: 'text', textValues: values.map((text) => ({ text })) }];
    await act(async () => root.render(<StableProbe />));
  };
  try {
    await render(['first']);
    expect(measureText).toHaveBeenCalledTimes(1);
    await render(['first', 'second']);
    expect(measureText).toHaveBeenCalledTimes(2);
    await render(['edited', 'second']);
    expect(measureText).toHaveBeenCalledTimes(3);
    expect(container.querySelector('table')?.getAttribute('data-width')).toBe('120');
  } finally {
    act(() => root.unmount());
    container.remove();
    canvas.mockRestore();
  }
});
