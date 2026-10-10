import { describe, expect, it, vi } from "vitest";
import {
  agentFileScopePath,
  agentFileScopePathForRuntime,
  handleAgentLinkClick,
  localFilePathFromAgentHref,
  openAgentLink,
} from "./link-navigation";
import { parseAgentLink } from './agent-link-parser';

const navigation = vi.hoisted(() => ({
  fileBrowser: vi.fn(async () => ({ host: 'browser-column' as const, tabId: 'files', alreadyOpen: false })),
  text: vi.fn(async () => ({ host: 'browser-column' as const, tabId: 'text', alreadyOpen: false })),
  web: vi.fn(async () => ({ host: 'browser-column' as const, tabId: 'web', alreadyOpen: false })),
}));
vi.mock('@features/workspace/use-cases/browser-column-navigation', () => ({
  openBrowserColumnFileBrowser: navigation.fileBrowser,
  openBrowserColumnText: navigation.text,
  openBrowserColumnWebpage: navigation.web,
}));

function target(href: string, context: Parameters<typeof parseAgentLink>[1] = {}) {
  const result = parseAgentLink(href, context);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.target;
}

function errorCode(href: string, context: Parameters<typeof parseAgentLink>[1] = {}) {
  const result = parseAgentLink(href, context);
  return result.ok ? null : result.code;
}

describe('parseAgentLink', () => {
  it('decodes the Windows Tauri HTTP link and retains its source line', () => {
    expect(target('http://tauri.localhost/D:/Notes/%E6%8E%A8%E5%B9%BF%E8%AE%BE%E8%AE%A1/Flowix%20Agent.md:144'))
      .toMatchObject({
        kind: 'local-file',
        flavor: 'windows-drive',
        path: 'D:/Notes/推广设计/Flowix Agent.md',
        location: { line: 144 },
      });
  });

  it('repairs a leading slash before a Windows drive and parses line and column together', () => {
    expect(target('/D:/Notes/a.ts:144:8')).toMatchObject({
      kind: 'local-file', path: 'D:/Notes/a.ts', location: { line: 144, column: 8 },
    });
    expect(target('D:\\Notes\\a.ts:144:8')).toMatchObject({
      kind: 'local-file', path: 'D:/Notes/a.ts', location: { line: 144, column: 8 },
    });
  });

  it('supports file URI line fragments and UNC paths', () => {
    expect(target('file:///D:/Notes/a%20b.md#L144C8')).toMatchObject({
      kind: 'local-file', path: 'D:/Notes/a b.md', location: { line: 144, column: 8 },
    });
    expect(target('file://server/share/a.md:9')).toMatchObject({
      kind: 'local-file', flavor: 'windows-unc', path: '//server/share/a.md', location: { line: 9 },
    });
    expect(target('\\\\server\\share\\a.md')).toMatchObject({
      kind: 'local-file', flavor: 'windows-unc', path: '//server/share/a.md',
    });
    expect(target('tauri://localhost/Users/u/a.md:9')).toMatchObject({
      kind: 'local-file', path: '/Users/u/a.md', location: { line: 9 },
    });
    expect(errorCode('tauri://localhost/index.html')).toBe('INVALID_PATH');
  });

  it('keeps protocol-relative links as web links unless file context explicitly allows UNC', () => {
    expect(target('//example.com/a')).toMatchObject({ kind: 'web', url: 'http://example.com/a' });
    expect(target('//server/share/a', { relativeMode: 'file', allowForwardSlashUnc: true }))
      .toMatchObject({ kind: 'local-file', path: '//server/share/a' });
  });

  it('does not reinterpret ordinary web URLs, local-origin lookalikes, or userinfo as files', () => {
    expect(target('https://example.com/a.ts:144#L9')).toMatchObject({ kind: 'web' });
    expect(target('http://tauri.localhost.example.com/D:/a.md')).toMatchObject({ kind: 'web' });
    expect(target('http://tauri.localhost@evil.example/D:/a.md')).toMatchObject({ kind: 'web' });
    expect(target('http://localhost:3000/D:/a.md')).toMatchObject({ kind: 'web' });
    expect(target('http://files.localhost/D:/a.md', {
      localOrigins: ['http://files.localhost'],
    })).toMatchObject({ kind: 'local-file', path: 'D:/a.md' });
  });

  it('decodes URI paths exactly once and preserves plus and encoded reserved characters', () => {
    expect(target('/Users/u/a%3A144')).toMatchObject({ kind: 'local-file', path: '/Users/u/a:144' });
    expect(target('/Users/u/%2520+%23%3F')).toMatchObject({ kind: 'local-file', path: '/Users/u/%20+#?' });
    expect(errorCode('/Users/u/a%')).toBe('INVALID_ENCODING');
    expect(errorCode('/Users/u/%00')).toBe('INVALID_ENCODING');
    expect(errorCode('/Users/u/%2Fsecret')).toBe('INVALID_ENCODING');
    expect(errorCode('/Users/u/%5Csecret')).toBe('INVALID_ENCODING');
  });

  it('rejects malformed locations, unsupported paths, and conflicting locations', () => {
    for (const href of ['/a.ts:0', '/a.ts:144:0', '/a.ts:9007199254740992', '/a.ts:144:8x', '/a.ts:144:']) {
      expect(errorCode(href), href).toBe('INVALID_LOCATION');
    }
    expect(errorCode('file:///D:/a.ts:144#L145')).toBe('CONFLICTING_LOCATION');
    expect(errorCode('file:///D:/a.ts:144#overview')).toBe('CONFLICTING_LOCATION');
    expect(errorCode('D:relative.txt')).toBe('UNSUPPORTED_SCHEME');
    expect(errorCode('\\\\server')).toBe('INVALID_PATH');
    expect(errorCode(String.raw`\\?\C:\device`)).toBe('INVALID_PATH');
  });

  it('resolves relative paths only with an explicit base and file mode', () => {
    expect(errorCode('./a.md:3')).toBe('AMBIGUOUS_TARGET');
    expect(target('./a.md:3', { relativeMode: 'file', baseDirectory: '/workspace' }))
      .toMatchObject({ kind: 'local-file', path: '/workspace/a.md', location: { line: 3 } });
    expect(target('../a.md', { relativeMode: 'file', baseDirectory: '/workspace' }))
      .toMatchObject({ kind: 'local-file', path: '/a.md' });
    expect(target('example.com/a', { relativeMode: 'web' })).toMatchObject({ kind: 'web', url: 'http://example.com/a' });
  });

  it('returns a clear platform error for Windows paths on POSIX platforms', () => {
    expect(errorCode('D:/a.ts', { platform: 'linux' })).toBe('UNSUPPORTED_PLATFORM');
  });
});

describe("localFilePathFromAgentHref", () => {
  it("resolves tauri localhost links and removes the display line suffix", () => {
    expect(localFilePathFromAgentHref(
      "tauri://localhost/Users/rop/Desktop/vibe/flowix-main/app/flowix-web/features/agent/components/agent-conversation-detail.tsx:563",
    )).toBe(
      "/Users/rop/Desktop/vibe/flowix-main/app/flowix-web/features/agent/components/agent-conversation-detail.tsx",
    );
  });

  it("rejects tauri links for non-local hosts", () => {
    expect(localFilePathFromAgentHref("tauri://example.com/Users/rop/file.ts")).toBeNull();
  });
});

describe('shared Agent link click dispatcher', () => {
  it('intercepts a raw DOM href and sends the same local-file target to navigation', async () => {
    navigation.text.mockClear();
    const root = document.createElement('div');
    root.innerHTML = '<a href="/Users/u/a%20b.md">source</a>';
    let handled = false;
    root.addEventListener('click', (event) => {
      handled = handleAgentLinkClick(event, null, vi.fn());
    });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    root.querySelector('a')!.dispatchEvent(event);
    await Promise.resolve();
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(navigation.text).toHaveBeenCalledWith('/Users/u/a b.md', null);
  });

  it('keeps the location from the latest click when an earlier open resolves later', async () => {
    const { peekAgentLocationRequest, consumeAgentLocationRequest } = await import(
      '@features/document/use-cases/agent-location-navigation',
    );
    let resolveFirst!: (value: { host: 'browser-column'; tabId: string; alreadyOpen: false }) => void;
    let resolveSecond!: (value: { host: 'browser-column'; tabId: string; alreadyOpen: false }) => void;
    navigation.text
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const first = openAgentLink('/Users/u/a.md:10', null);
    const second = openAgentLink('/Users/u/a.md:144', null);
    resolveSecond({ host: 'browser-column', tabId: 'a', alreadyOpen: false });
    await second;
    resolveFirst({ host: 'browser-column', tabId: 'a', alreadyOpen: false });
    await first;

    const request = peekAgentLocationRequest('/Users/u/a.md');
    expect(request?.location).toEqual({ line: 144 });
    if (request) consumeAgentLocationRequest(request.path, request.id);
  });
});

describe("agentFileScopePath", () => {
  it("treats the POSIX root as containing absolute descendants", () => {
    expect(agentFileScopePath("/Users/rop/file.ts", ["/"])).toBe("/");
  });

  it("uses path-segment boundaries and rejects lexical traversal", () => {
    expect(agentFileScopePath("/workspace-other/file.ts", ["/workspace"])).toBeNull();
    expect(agentFileScopePath("/workspace/../secret/file.ts", ["/workspace"])).toBeNull();
  });

  it("selects the narrowest containing workspace", () => {
    expect(agentFileScopePath("/workspace/packages/app/src/a.ts", [
      "/workspace",
      "/workspace/packages/app",
    ])).toBe("/workspace/packages/app");
  });

  it("compares Windows drive and UNC paths case-insensitively", () => {
    expect(agentFileScopePath("c:\\WORK\\src\\a.ts", ["C:\\Work"])).toBe("C:\\Work");
    expect(agentFileScopePath("\\\\SERVER\\Share\\src\\a.ts", ["\\\\server\\share"])).toBe(
      "\\\\server\\share",
    );
  });

  it("does not compare paths from different filesystem flavors", () => {
    expect(agentFileScopePath("/C:/Work/a.ts", ["C:\\Work"])).toBeNull();
  });

  it("derives scopes from the conversation workspace snapshot", () => {
    expect(agentFileScopePathForRuntime(
      "/workspace/packages/app/src/a.ts",
      {
        workspaceSnapshot: {
          version: 1,
          cwd: "/workspace",
          workspacePaths: ["/workspace", "/workspace/packages/app"],
          capturedAt: 1,
        },
      },
    )).toBe("/workspace/packages/app");
  });
});
