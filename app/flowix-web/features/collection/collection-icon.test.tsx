import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PROPERTY_ICON_OPTIONS } from '@features/document/properties/property-icons';
import { CollectionDatabaseIcon, CollectionIcon, CollectionResourceIcon, collectionDefaultIcon } from './collection-icon';
import type { CollectionDomain } from './model';

const state = vi.hoisted(() => ({ summary: null as unknown }));
vi.mock('./use-collection-summary', () => ({ useCollectionSummary: () => [state.summary] }));

it.each(['calendar', 'kanban', 'gallery', 'table'])('uses the table default for a %s note view', (layout) => {
  expect(collectionDefaultIcon([{ domain: 'notes', layout } as { domain: CollectionDomain }])).toBe('multidimensional-table');
});
it.each(['media', 'work_documents'] as const)('uses the media default for %s views', (domain) => {
  expect(collectionDefaultIcon([{ domain }])).toBe('media-library');
});
it('follows the rendered tab order, where note views precede assets and files are not views', () => {
  expect(collectionDefaultIcon([{ domain: 'media' }, { domain: 'notes' }])).toBe('multidimensional-table');
  expect(collectionDefaultIcon([])).toBe('multidimensional-table');
});

it('uses the same defaults in headers and tree rows, with persisted custom icons taking precedence', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    state.summary = { views: [{ domain: 'work_documents' }], properties: {} };
    await act(async () => root.render(<>
      <div data-header><CollectionIcon defaultIcon="media-library" /></div>
      <div data-tree><CollectionResourceIcon filePath="/book/a.index.yaml" notebookPath="/book" /></div>
      <div data-reference><CollectionDatabaseIcon /></div>
    </>));
    const reference = host.querySelector('[data-reference] svg')?.innerHTML;
    expect(reference).toBeTruthy();
    expect(host.querySelector('[data-header] svg')?.innerHTML).toBe(reference);
    expect(host.querySelector('[data-tree] svg')?.innerHTML).toBe(reference);
    const icon = PROPERTY_ICON_OPTIONS[0]!;
    state.summary = { views: [{ domain: 'notes' }], properties: { icon: { type: 'Text', value: icon.value } } };
    await act(async () => root.render(<CollectionResourceIcon filePath="/book/a.index.yaml" notebookPath="/book" />));
    expect(host.querySelector('img')?.getAttribute('src')).toBe(icon.src);
    expect(host.querySelector('svg')).toBeNull();
    state.summary = { views: [{ domain: 'notes' }], properties: {} };
    await act(async () => root.render(<CollectionResourceIcon filePath="/book/a.index.yaml" notebookPath="/book" />));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('svg')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});
