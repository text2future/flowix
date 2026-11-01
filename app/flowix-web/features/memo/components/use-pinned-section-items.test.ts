import { describe, expect, it } from 'vitest';

import type { DocTreeItem } from '@platform/tauri/client';
import type { PinnedTreeItem } from './use-notebook-pinned-notes';
import { buildPinnedSectionItems } from './use-pinned-section-items';

const ROOT = '/notes';

function folder(name: string, createdMs = 0, children: DocTreeItem[] | null = null): DocTreeItem {
  return {
    id: `folder:${name}`,
    fullPath: name.startsWith('/') ? name : `${ROOT}/${name}`,
    name: name.split('/').pop() ?? name,
    type: 'folder',
    parentId: null,
    children,
    sizeBytes: null,
    modifiedMs: 0,
    createdMs,
    memoCreatedMs: null,
  };
}

function note(name: string, parent: string, createdMs: number): DocTreeItem {
  return {
    id: `note:${parent}/${name}`,
    fullPath: `${parent}/${name}`,
    name,
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: 10,
    modifiedMs: createdMs,
    createdMs,
    memoCreatedMs: createdMs,
    resourceKind: 'note',
  };
}

function pinnedEntry(relativePath: string, kind: PinnedTreeItem['pinnedEntryKind']): PinnedTreeItem {
  return {
    id: `pinned:${relativePath}`,
    fullPath: `${ROOT}/${relativePath}`,
    name: relativePath,
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: null,
    modifiedMs: 0,
    createdMs: 1,
    memoCreatedMs: 1,
    resourceKind: 'other',
    pinned: true,
    pinnedEntryKind: kind,
  };
}

function build(overrides: Partial<Parameters<typeof buildPinnedSectionItems>[0]> = {}) {
  const projects = folder('Projects', 100);
  const archive = folder('Archive', 300);
  const children = [note('a.md', `${ROOT}/Projects`, 80), note('b.md', `${ROOT}/Projects`, 50)];
  const nodes = new Map<string, DocTreeItem>([
    [`${ROOT}/Projects`, { ...projects, children }],
    [`${ROOT}/Archive`, archive],
  ]);
  return buildPinnedSectionItems({
    entries: [],
    folderPaths: [],
    loadedItems: [projects, archive],
    nodes,
    expanded: new Set<string>(),
    sort: 'createdAt',
    ...overrides,
  });
}

describe('buildPinnedSectionItems', () => {
  it('returns the entries untouched when no folder is pinned', () => {
    const entries = [pinnedEntry('note.md', 'note')];
    expect(build({ entries })).toBe(entries);
  });

  it('lists pinned folders before the entries, in sidebar order', () => {
    const entries = [pinnedEntry('note.md', 'note')];
    const items = build({ entries, folderPaths: [`${ROOT}/Archive`, `${ROOT}/Projects`] });
    expect(items.map((item) => item.name)).toEqual(['Archive', 'Projects', 'note.md']);
    expect(items.map((item) => item.pinnedEntryKind)).toEqual(['folder', 'folder', 'note']);
    expect(items.map((item) => item.pinnedDepth)).toEqual([0, 0, undefined]);
  });

  it('expands a pinned folder in place and indents its children', () => {
    const items = build({
      folderPaths: [`${ROOT}/Projects`],
      expanded: new Set([`${ROOT}/Projects`]),
    });
    expect(items.map((item) => [item.name, item.pinnedDepth])).toEqual([
      ['Projects', 0],
      ['a.md', 1],
      ['b.md', 1],
    ]);
    expect(items[0].pinnedExpanded).toBe(true);
  });

  it('keeps a collapsed pinned folder to a single row', () => {
    const items = build({ folderPaths: [`${ROOT}/Projects`] });
    expect(items).toHaveLength(1);
    expect(items[0].pinnedExpanded).toBe(false);
  });

  it('shows a pinned subfolder at the same level as its pinned parent', () => {
    const sub = folder(`${ROOT}/Projects/Sub`, 10);
    const projects = folder('Projects', 100, [sub]);
    const items = build({
      folderPaths: [`${ROOT}/Projects`, `${ROOT}/Projects/Sub`],
      loadedItems: [projects],
      nodes: new Map<string, DocTreeItem>([
        [`${ROOT}/Projects`, projects],
        [`${ROOT}/Projects/Sub`, sub],
      ]),
      expanded: new Set([`${ROOT}/Projects`]),
    });
    expect(items.map((item) => [item.name, item.pinnedDepth])).toEqual([
      ['Projects', 0],
      ['Sub', 0],
    ]);
  });

  it('expands a pinned subfolder in place even when its parent is collapsed', () => {
    const nested = note('deep.md', `${ROOT}/Projects/Sub`, 5);
    const sub = folder(`${ROOT}/Projects/Sub`, 10, [nested]);
    const projects = folder('Projects', 100, [sub]);
    const items = build({
      folderPaths: [`${ROOT}/Projects`, `${ROOT}/Projects/Sub`],
      loadedItems: [projects],
      nodes: new Map<string, DocTreeItem>([
        [`${ROOT}/Projects`, projects],
        [`${ROOT}/Projects/Sub`, sub],
      ]),
      expanded: new Set([`${ROOT}/Projects/Sub`]),
    });
    expect(items.map((item) => [item.name, item.pinnedDepth])).toEqual([
      ['Projects', 0],
      ['Sub', 0],
      ['deep.md', 1],
    ]);
  });

  it('still shows a pinned folder that was never loaded', () => {
    const items = build({ folderPaths: [`${ROOT}/NeverOpened`] });
    expect(items.map((item) => [item.name, item.type, item.pinnedEntryKind]))
      .toEqual([['NeverOpened', 'folder', 'folder']]);
  });

  it('keeps a child row on its own pin flag and open kind', () => {
    const items = build({
      folderPaths: [`${ROOT}/Projects`],
      expanded: new Set([`${ROOT}/Projects`]),
    });
    const child = items[1];
    expect(child.pinnedEntryKind).toBe('note');
    expect(child.pinned).toBeUndefined();
  });

  it('does not pin a subfolder just because its parent is pinned', () => {
    const sub = folder(`${ROOT}/Projects/Sub`, 10);
    const projects = folder('Projects', 100, [sub]);
    const items = build({
      folderPaths: [`${ROOT}/Projects`],
      loadedItems: [projects],
      nodes: new Map<string, DocTreeItem>([
        [`${ROOT}/Projects`, projects],
        [`${ROOT}/Projects/Sub`, sub],
      ]),
      expanded: new Set([`${ROOT}/Projects`]),
    });
    expect(items.map((item) => [item.name, item.pinned])).toEqual([
      ['Projects', true],
      ['Sub', false],
    ]);
    // It is still a folder row, so its own menu can pin it.
    expect(items[1].pinnedEntryKind).toBe('folder');
  });

  it('keeps the flag on a subfolder that is pinned itself', () => {
    const sub = folder(`${ROOT}/Projects/Sub`, 10);
    const projects = folder('Projects', 100, [sub]);
    const items = build({
      folderPaths: [`${ROOT}/Projects`, `${ROOT}/Projects/Sub`],
      loadedItems: [projects],
      nodes: new Map<string, DocTreeItem>([
        [`${ROOT}/Projects`, projects],
        [`${ROOT}/Projects/Sub`, sub],
      ]),
      expanded: new Set([`${ROOT}/Projects`]),
    });
    expect(items.map((item) => [item.name, item.pinned, item.pinnedDepth])).toEqual([
      ['Projects', true, 0],
      ['Sub', true, 0],
    ]);
  });
});
