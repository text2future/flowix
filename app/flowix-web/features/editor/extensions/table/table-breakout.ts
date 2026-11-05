import { Plugin, PluginKey } from '@tiptap/pm/state';

/** Only the outer document's top-level tables may use the pane's side margins. */
export function createTableBreakoutPlugin() {
  return new Plugin({
    key: new PluginKey('tableBreakout'),
    view(view) {
      const root = view.dom;
      const pane = root.closest<HTMLElement>('.editor-content');
      if (!pane || root.closest('.agent-conversation-surface')) return {};
      const ownerWindow = root.ownerDocument.defaultView!;
      let frame = 0;
      const setLength = (name: string, value: number) => {
        const property = `--markdown-table-${name}`;
        const next = `${value}px`;
        if (root.style.getPropertyValue(property) !== next) root.style.setProperty(property, next);
      };
      const sync = () => {
        frame = 0;
        const width = pane.clientWidth;
        const rect = root.getBoundingClientRect();
        if (width <= 0 || rect.width <= 0) return;
        const style = ownerWindow.getComputedStyle(root);
        // DOM rects are viewport coordinates; convert back to CSS layout pixels
        // when the editor is inside a scaled surface.
        const paneRect = pane.getBoundingClientRect();
        const scale = pane.offsetWidth > 0 ? paneRect.width / pane.offsetWidth : 1;
        const inset = Math.max(0, (rect.left - paneRect.left) / (scale || 1)
          - pane.clientLeft + (parseFloat(style.paddingLeft) || 0));
        setLength('pane-width', width);
        setLength('leading-space', inset);
        setLength('content-width', Math.max(0,
          root.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)));
        if (root.dataset.tableBreakout !== 'true') root.dataset.tableBreakout = 'true';
      };
      const schedule = () => {
        if (!frame) frame = ownerWindow.requestAnimationFrame(sync);
      };
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
      observer?.observe(root);
      observer?.observe(pane);
      ownerWindow.addEventListener('resize', schedule);
      schedule();
      return {
        update: schedule,
        destroy() {
          ownerWindow.cancelAnimationFrame(frame);
          observer?.disconnect();
          ownerWindow.removeEventListener('resize', schedule);
          delete root.dataset.tableBreakout;
          for (const name of ['pane-width', 'leading-space', 'content-width']) {
            root.style.removeProperty(`--markdown-table-${name}`);
          }
        },
      };
    },
  });
}
