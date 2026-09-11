import GithubSlugger from 'github-slugger';

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const NON_DOCUMENT_HEADING_SELECTOR = '.agent-thread-card, .frontmatter-property-node';
const HEADING_SCROLL_OFFSET_PX = 16;

function decodeAnchorFragment(href: string): string {
  const fragment = href.startsWith('#') ? href.slice(1) : href;
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Resolve a GitHub-style Markdown heading fragment inside one editor only.
 *
 * Heading slugs are derived at click time so edits are reflected immediately
 * and multiple open editor surfaces do not need globally unique DOM ids.
 */
export function findHeadingByAnchor(
  editorRoot: HTMLElement,
  href: string,
): HTMLElement | null {
  const fragment = decodeAnchorFragment(href);
  if (!fragment) return null;

  const slugger = new GithubSlugger();
  const headings = editorRoot.querySelectorAll<HTMLElement>(HEADING_SELECTOR);

  for (const heading of headings) {
    if (heading.closest(NON_DOCUMENT_HEADING_SELECTOR)) continue;
    if (slugger.slug(heading.textContent ?? '') === fragment) {
      return heading;
    }
  }

  return null;
}

/** Scroll an in-note Markdown fragment into view without changing selection. */
export function navigateToHeadingAnchor(
  editorRoot: HTMLElement,
  href: string,
): boolean {
  const target = findHeadingByAnchor(editorRoot, href);
  if (!target) return false;

  const scrollContainer = editorRoot.closest<HTMLElement>('.editor-content');
  if (!scrollContainer) {
    target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    return true;
  }

  const targetRect = target.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  const top = Math.max(
    0,
    scrollContainer.scrollTop + targetRect.top - containerRect.top - HEADING_SCROLL_OFFSET_PX,
  );
  const reduceMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  scrollContainer.scrollTo({
    top,
    behavior: reduceMotion ? 'auto' : 'smooth',
  });
  return true;
}
