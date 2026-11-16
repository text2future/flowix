import { describe, expect, it } from 'vitest';
import { surfaceRenderPolicy } from './surface-render-policy';

describe('surfaceRenderPolicy', () => {
  it('keeps the main column on the host loading layer and the session-owned view id', () => {
    expect(surfaceRenderPolicy('column-1', 'work:entry')).toEqual({
      loadingOwner: 'host',
      navigationViewId: undefined,
      fileShell: 'surface',
      collectionLocation: { host: 'column-1' },
    });
  });

  it('makes the secondary column own loading, navigation history and the file shell', () => {
    expect(surfaceRenderPolicy('column-2', 'browser:entry')).toEqual({
      loadingOwner: 'surface',
      navigationViewId: 'browser:entry',
      fileShell: 'host',
      collectionLocation: { host: 'column-2', surfaceId: 'browser:entry' },
    });
  });
});
