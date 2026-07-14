import { describe, expect, it } from 'vitest';

import {
  createAgentThreadCardCommandList,
} from './agent-thread-card-command-renderer';
import type { AgentCommandItem } from '@features/agent/tool-display';

const POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function findSpan(root: HTMLElement, className: string): HTMLSpanElement {
  const node = root.querySelector(`span.${className}`);
  if (!(node instanceof HTMLSpanElement)) {
    throw new Error(`expected <span class="${className}"> in ${root.outerHTML}`);
  }
  return node;
}

describe('agent-thread-card command renderer — path basename', () => {
  it('strips Windows path prefix and shows only the executable name', () => {
    const item: AgentCommandItem = {
      command: POWERSHELL,
      args: ['-Command', 'rg', '-n', '"PRAGMA foreign"'],
      env: [],
      raw: `${POWERSHELL} -Command rg -n "PRAGMA foreign"`,
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('powershell.exe');
  });

  it('strips POSIX path prefix and shows only the executable name', () => {
    const item: AgentCommandItem = {
      command: '/usr/local/bin/node',
      args: ['script.js'],
      env: [],
      raw: '/usr/local/bin/node script.js',
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('node');
  });

  it('handles forward-slash paths', () => {
    const item: AgentCommandItem = {
      command: 'C:/Python311/python.exe',
      args: ['-V'],
      env: [],
      raw: 'C:/Python311/python.exe -V',
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('python.exe');
  });

  it('keeps short commands without path separators untouched', () => {
    const item: AgentCommandItem = {
      command: 'rg',
      args: ['-n', 'pattern'],
      env: [],
      raw: 'rg -n pattern',
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('rg');
  });

  it('keeps script.sh (no separator) untouched', () => {
    const item: AgentCommandItem = {
      command: 'script.sh',
      args: [],
      env: [],
      raw: 'script.sh',
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('script.sh');
  });

  it('keeps title as the full original command for hover', () => {
    const item: AgentCommandItem = {
      command: POWERSHELL,
      args: ['-Command', 'rg'],
      env: [],
      raw: `${POWERSHELL} -Command rg`,
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('powershell.exe');
    expect(name.title).toBe(POWERSHELL);
  });

  it('does not touch args when command is a path', () => {
    const args = ['-Command', 'rg', '-n', '"PRAGMA foreign"'];
    const item: AgentCommandItem = {
      command: POWERSHELL,
      args,
      env: [],
      raw: `${POWERSHELL} ${args.join(' ')}`,
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const argText = findSpan(list, 'agent-thread-card__command-args-inline');
    expect(argText.textContent).toBe(args.join(' '));
    expect(argText.title).toBe(args.join(' '));
  });
});