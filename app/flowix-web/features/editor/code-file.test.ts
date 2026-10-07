import { describe, expect, it } from 'vitest';

import {
  externalFileViewKind,
  fileExtension,
  isCodeTextFilePath,
  isEditableTextFilePath,
  isImageFilePath,
  isMarkdownFilePath,
  isTextMimeType,
  resourceKindFromPath,
} from '@features/editor/code-file';

describe('code file classification', () => {
  it('classifies Markdown separately from CodeMirror text files', () => {
    expect(isMarkdownFilePath('/notes/README.MD')).toBe(true);
    expect(isCodeTextFilePath('/src/app.tsx')).toBe(true);
    expect(isCodeTextFilePath('/data/settings.JSON')).toBe(true);
    expect(isCodeTextFilePath('/notes/plain.txt')).toBe(true);
    expect(isCodeTextFilePath('/notes/readme.md')).toBe(false);
  });

  it('rejects unknown extensions until their MIME type is known to be text', () => {
    expect(isEditableTextFilePath('/assets/logo.png')).toBe(false);
    expect(isEditableTextFilePath('/src/Makefile')).toBe(false);
    expect(isEditableTextFilePath('/src/LICENSE')).toBe(false);
    expect(isEditableTextFilePath('/src/data.custom', 'text/plain')).toBe(true);
    expect(isEditableTextFilePath('/src/archive.custom', 'application/octet-stream')).toBe(false);
    expect(isTextMimeType('text/csv; charset=utf-8')).toBe(true);
    expect(fileExtension('/src/.env')).toBe('');
  });

  it('routes PDF files to the unavailable external-file view', () => {
    expect(resourceKindFromPath('/notebook/report.PDF')).toBe('other');
    expect(externalFileViewKind('/notebook/report.PDF')).toBe('unavailable');
  });

  it('classifies common image files for direct preview', () => {
    expect(isImageFilePath('/assets/photo.JPEG')).toBe(true);
    expect(isImageFilePath('/assets/icon.svg')).toBe(true);
    expect(isImageFilePath('/assets/archive.zip')).toBe(false);
  });
});
