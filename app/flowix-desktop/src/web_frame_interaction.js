// Each embedded document forwards only its own or a direct child's interaction.
// No page input is cancelled and no DOM event is synthesized in the host.
(() => {
  if (window === window.top) return;
  const TYPE = 'flowix:web-frame-pointerdown';
  const report = () => window.parent.postMessage({ type: TYPE, version: 1 }, '*');
  document.addEventListener('pointerdown', report, true);
  window.addEventListener('message', event => {
    if (event.data?.type !== TYPE || event.data?.version !== 1 || !event.source) return;
    for (let index = 0; index < window.frames.length; index++) {
      if (window.frames[index] === event.source) {
        report();
        return;
      }
    }
  });
})();
