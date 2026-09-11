import { describe, expect, it } from 'vitest';

import { getResourceSetiIcon } from './resource-file-icon';

describe('getResourceSetiIcon', () => {
  it.each([
    ['README.MD', '_info_light'],
    ['LICENSE', '_license_light'],
    ['index.html', '_html_3_light'],
    ['button.test.tsx', '_react_1_light'],
    ['photo.JPEG', '_image_light'],
    ['report.docx', '_word_light'],
    ['recording.mp4', '_video_light'],
    ['archive.zip', '_zip_1_light'],
    ['budget.xlsx', '_xls_light'],
    ['manual.pdf', '_pdf_light'],
  ])('uses the native Seti mapping for %s', (filename, expectedDefinition) => {
    expect(getResourceSetiIcon(filename, 'light').definitionKey).toBe(expectedDefinition);
  });

  it('uses the native dark Seti definition when the app theme is dark', () => {
    const lightIcon = getResourceSetiIcon('index.tsx', 'light');
    const darkIcon = getResourceSetiIcon('index.tsx', 'dark');

    expect(lightIcon.definitionKey).toBe('_react_light');
    expect(darkIcon.definitionKey).toBe('_react');
    expect(lightIcon.color).not.toBe(darkIcon.color);
  });

  it('uses Seti default for unknown extensions', () => {
    expect(getResourceSetiIcon('data.bin', 'light').definitionKey).toBe('_default_light');
    expect(getResourceSetiIcon('data.bin', 'dark').definitionKey).toBe('_default');
  });
});
