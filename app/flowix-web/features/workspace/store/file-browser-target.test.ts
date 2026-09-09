import { describe, expect, it } from 'vitest';
import { resolveFileBrowserRoot } from './file-browser-target';

describe('file browser resource membership', () => {
  it('uses the deepest directory boundary and rejects similarly named neighbors', () => {
    const folders = ['/project', '/project/src'];
    expect(resolveFileBrowserRoot('/project/src/main.ts', folders)).toBe('/project/src');
    expect(resolveFileBrowserRoot('/project-other/main.ts', folders)).toBeNull();
    expect(resolveFileBrowserRoot('/outside/main.ts', folders)).toBeNull();
  });
  it('handles separators, trailing slashes, root folders and parent segments', () => {
    expect(resolveFileBrowserRoot('C:\\work\\src\\main.ts', ['C:/work/'])).toBe('C:/work');
    expect(resolveFileBrowserRoot('/work/../outside/a.ts', ['/work'])).toBeNull();
    expect(resolveFileBrowserRoot('/a.ts', ['/'])).toBe('/');
    expect(resolveFileBrowserRoot('/a.ts', [''])).toBeNull();
  });
  it('does not guess filesystem case folding or require resources before a file can open', () => {
    expect(resolveFileBrowserRoot('/Work/a.ts', ['/work'])).toBeNull();
    expect(resolveFileBrowserRoot('/work/a.ts', [])).toBeNull();
    expect(resolveFileBrowserRoot(null, ['/work'])).toBeNull();
  });
});
