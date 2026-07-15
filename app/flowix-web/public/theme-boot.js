/*
 * First-paint theme boot.
 *
 * React reads ~/.flowix/boot/preference.json through async Tauri IPC, which is
 * too late for the first frame of a new WebView. This script runs before CSS
 * paint and uses, in order:
 *   1. one-shot ?bootTheme= injected by the desktop window command;
 *   2. localStorage cache written by applyTheme();
 *   3. system color scheme.
 *
 * Keep VALID_RESOLVED_THEMES in sync with app/flowix-web/features/theme/palette.ts,
 * excluding "system" because this script only writes resolved data-theme values.
 */
(function () {
  try {
    var VALID_RESOLVED_THEMES = ['dark', 'light', 'rock', 'mist', 'ember'];
    var params = new URLSearchParams(window.location.search || '');
    var bootTheme = params.get('bootTheme');
    var cached = bootTheme || localStorage.getItem('flowix-theme');
    var resolved;

    if (VALID_RESOLVED_THEMES.indexOf(cached) !== -1) {
      resolved = cached;
    } else {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }

    var root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved === 'dark' ? 'dark' : 'light';

    if (bootTheme && window.history && window.history.replaceState) {
      params.delete('bootTheme');
      var query = params.toString();
      var nextUrl = window.location.pathname + (query ? '?' + query : '') + window.location.hash;
      window.history.replaceState(null, document.title, nextUrl);
    }
  } catch (_) {
    // Fall back to light.css :root defaults.
  }
})();
