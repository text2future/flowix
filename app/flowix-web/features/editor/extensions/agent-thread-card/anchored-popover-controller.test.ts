import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnchoredPopoverController } from './anchored-popover-controller';

describe('anchored popover controller', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not schedule positioning when the popover is closed', () => {
    const position = vi.fn();
    const controller = createAnchoredPopoverController({
      isOpen: () => false,
      isDestroyed: () => false,
      isHidden: () => false,
      position,
    });
    const raf = vi.spyOn(window, 'requestAnimationFrame');

    controller.schedule();

    expect(raf).not.toHaveBeenCalled();
    expect(position).not.toHaveBeenCalled();
  });

  it('schedules one animation frame while open', () => {
    const position = vi.fn();
    const controller = createAnchoredPopoverController({
      isOpen: () => true,
      isDestroyed: () => false,
      isHidden: () => false,
      position,
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(1);
      return 1;
    });

    controller.schedule();

    expect(position).toHaveBeenCalledTimes(1);
  });

  it('registers viewport listeners and removes them on stop', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const controller = createAnchoredPopoverController({
      isOpen: () => true,
      isDestroyed: () => false,
      isHidden: () => false,
      position: vi.fn(),
    });

    controller.start();
    controller.stop();

    expect(add).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(add).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function), true);
  });
});
