'use client';

import { useSyncExternalStore } from 'react';

import setiIconTheme from '@/assets/seti/vs-seti-icon-theme.json';

type SetiThemeVariant = 'light' | 'dark';

type SetiIconDefinition = {
  fontCharacter: string;
  fontColor?: string;
};

type SetiThemeMapping = {
  file?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
};

const SETI_FONT_FAMILY = 'FlowixSeti';
const SETI_FOLDER_GLYPH = '\uE033';
const SETI_FOLDER_COLOR = '#ABABAB';

const SETI_DARK_MAPPING = setiIconTheme as unknown as SetiThemeMapping & {
  iconDefinitions: Record<string, SetiIconDefinition>;
  light?: SetiThemeMapping;
};
const SETI_LIGHT_MAPPING = SETI_DARK_MAPPING.light ?? {};
const SETI_DEFAULT_COLORS = {
  dark: SETI_DARK_MAPPING.iconDefinitions._default.fontColor ?? '#d4d7d6',
  light: SETI_DARK_MAPPING.iconDefinitions._default_light.fontColor ?? '#bfc2c1',
};

// VS Code can resolve an icon through the active language mode. Flowix only
// has a path, so keep the common path-to-language part of that resolution here.
const LANGUAGE_ID_BY_EXTENSION: Record<string, string> = {
  cjs: 'javascript',
  css: 'css',
  go: 'go',
  htm: 'html',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascriptreact',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  sh: 'shellscript',
  sql: 'sql',
  svg: 'xml',
  ts: 'typescript',
  tsx: 'typescriptreact',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

/** Seti stores private-use code points as strings such as "\\E099". */
function decodeSetiGlyph(fontCharacter: string): string {
  const match = /^\\([0-9a-f]+)$/i.exec(fontCharacter);
  return match ? String.fromCodePoint(Number.parseInt(match[1], 16)) : fontCharacter;
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop()?.toLowerCase() ?? path.toLowerCase();
}

/**
 * Match Seti's longest extension suffix so mappings such as `test.tsx` and
 * `tf.json` win over the generic `tsx` and `json` mappings.
 */
function getExtensionCandidates(fileName: string): string[] {
  const candidates: string[] = [];
  let dotIndex = fileName.indexOf('.');
  while (dotIndex >= 0 && dotIndex < fileName.length - 1) {
    candidates.push(fileName.slice(dotIndex + 1));
    dotIndex = fileName.indexOf('.', dotIndex + 1);
  }
  return candidates.sort((a, b) => b.length - a.length);
}

function getSetiDefinitionKey(path: string, variant: SetiThemeVariant): string {
  const mapping = variant === 'dark' ? SETI_DARK_MAPPING : SETI_LIGHT_MAPPING;
  const fileName = getFileName(path);

  const fileNameKey = mapping.fileNames?.[fileName];
  if (fileNameKey) return fileNameKey;

  for (const extension of getExtensionCandidates(fileName)) {
    const extensionKey = mapping.fileExtensions?.[extension];
    if (extensionKey) return extensionKey;

    const languageId = LANGUAGE_ID_BY_EXTENSION[extension];
    const languageKey = languageId ? mapping.languageIds?.[languageId] : undefined;
    if (languageKey) return languageKey;
  }

  return mapping.file ?? (variant === 'dark' ? '_default' : '_default_light');
}

export type ResourceSetiIcon = {
  definitionKey: string;
  glyph: string;
  color: string;
};

export function getResourceSetiIcon(path: string, variant: SetiThemeVariant): ResourceSetiIcon {
  const definitionKey = getSetiDefinitionKey(path, variant);
  const definition = SETI_DARK_MAPPING.iconDefinitions[definitionKey]
    ?? SETI_DARK_MAPPING.iconDefinitions[variant === 'dark' ? '_default' : '_default_light'];

  return {
    definitionKey,
    glyph: decodeSetiGlyph(definition.fontCharacter),
    color: definition.fontColor ?? SETI_DEFAULT_COLORS[variant],
  };
}

function getSetiThemeVariant(): SetiThemeVariant {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribeToSetiTheme(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const root = document.documentElement;
  const observer = new MutationObserver(onStoreChange);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('app-theme-changed', onStoreChange);

  return () => {
    observer.disconnect();
    window.removeEventListener('app-theme-changed', onStoreChange);
  };
}

function useSetiThemeVariant(): SetiThemeVariant {
  return useSyncExternalStore(
    subscribeToSetiTheme,
    getSetiThemeVariant,
    () => 'light',
  );
}

function setiIconStyle(color: string) {
  return {
    color,
    fontFamily: SETI_FONT_FAMILY,
    fontSize: '16px',
    fontStyle: 'normal',
    fontWeight: 'normal',
    lineHeight: 1,
  } as const;
}

export function ResourceFileIcon({ path, className }: { path: string; className?: string }) {
  const variant = useSetiThemeVariant();
  const icon = getResourceSetiIcon(path, variant);

  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center select-none ${className ?? ''}`}
      data-seti-icon={icon.definitionKey}
      style={setiIconStyle(icon.color)}
    >
      {icon.glyph}
    </span>
  );
}

/** Seti's file icon theme does not define a separate open-folder glyph. */
export function ResourceFolderIcon({ className }: { expanded: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center select-none ${className ?? ''}`}
      data-seti-icon="_folder"
      style={setiIconStyle(SETI_FOLDER_COLOR)}
    >
      {SETI_FOLDER_GLYPH}
    </span>
  );
}
