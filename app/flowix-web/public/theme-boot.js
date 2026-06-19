/*
 * 首屏 boot: 在 CSS paint 之前把 data-theme 写到 <html>, 防止深色模式下
 * 偏好设置/主窗口出现一帧白色闪烁。
 *
 * 主题真源在 ~/.flowix/preference.json (Tauri IPC), 但 IPC 是 async — 等到
 * React mount + useEffect 跑完时, 首帧已经画完。 这里用 localStorage 做
 * 同步缓存, 与 lib/theme/apply.ts 写入的 key 保持一致; 缓存由 applyTheme
 * 在每次主题解析后更新, 真源修改后再开窗也能命中。
 *
 * 镜像 DEFAULT_THEME_ID='system' 的语义: 无缓存时跟随系统外观 (而不是
 * 直接选 light — 那样在系统是 dark 的用户那里同样会闪)。
 *
 * 走独立 JS 文件 (而不是 index.html inline) 是因为 Tauri CSP 的
 *   script-src 'self' 'unsafe-eval'
 * 不含 'unsafe-inline', inline <script> 会被拦截; 走同源外部脚本即可。
 */
(function () {
  try {
    var cached = localStorage.getItem('flowix-theme');
    var resolved;
    if (cached === 'dark' || cached === 'light' || cached === 'rock') {
      resolved = cached;
    } else {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    var root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved === 'dark' ? 'dark' : 'light';
  } catch (_) {
    // localStorage 不可用 (隐私模式 / 磁盘满) 时静默回退到 light.css :root
    // 默认, 行为退化到修复前的状态。
  }
})();
