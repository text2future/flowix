import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { isRelativePathHref } from '@features/editor/public/code-file';
import { translate } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('anchor-link-guard');

let installed = false;

/**
 * 点击相对链接时的最后一道防线。
 *
 * 编辑器的链接拦截挂在悬停提示模块上（`attachLinkHoverTooltip`），附着点是
 * 编辑器根节点的冒泡阶段。只要它没挂上、正处在编辑器重建的间隙，或事件在中途
 * 被 `stopPropagation`，点击就会退回 webview 的默认导航。markdown 链接带
 * `target="_blank"`，而 dev 下应用自身就运行在 `http://localhost:1420`：相对
 * 链接会被按页面地址解析成应用自己的 URL，交给系统浏览器打开。dev server 对
 * 未知路径做 SPA fallback，于是整个应用壳在一个没有 Tauri 注入的普通网页里
 * 重启一遍，随即在 `getCurrentWindow()` 处抛 `reading 'metadata'` 之类的错误。
 *
 * 因此这里只在**没人处理过**时兜底：挂在冒泡阶段最后执行，`defaultPrevented`
 * 为真就完全不动；只有无 scheme 的相对路径才拦，web 链接、锚点、flowix:// 与
 * 绝对路径都保持原语义。
 */
export function attachAnchorLinkGuard(targetDocument: Document): () => void {
  const handleClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const anchor = (event.target instanceof Element ? event.target : null)
      ?.closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    if (!isRelativePathHref(anchor.getAttribute('href'))) return;
    event.preventDefault();
    // 不记录 href：日志里不放用户路径。
    log.warn('blocked unresolved relative link navigation');
    toast.error(translate(getCurrentAppLanguage(), 'errors.friendly.linkOpen'));
  };

  targetDocument.addEventListener('click', handleClick);
  return () => targetDocument.removeEventListener('click', handleClick);
}

/** 入口处调用一次；重复调用无副作用。 */
export function installAnchorLinkGuard(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  attachAnchorLinkGuard(document);
}
