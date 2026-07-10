export interface CodeBlockCandidate {
  startLine: number;
  endLine: number;
  language: string;
  confidence: number;
}

const FENCE_LINE_RE = /^\s*(```|~~~)/;
const LANGUAGE_LINE_RE = /^([a-zA-Z][\w#+.-]{0,30})\s*$/;
const JSON_LANGUAGE_IDS = new Set(['json', 'jsonc', 'json5']);
const SHELL_LANGUAGE_IDS = new Set(['bash', 'shell', 'sh']);
const TEXT_LANGUAGE_IDS = new Set(['plain', 'plaintext', 'text', 'txt']);
const LOOSE_CODE_LANGUAGE_IDS = new Set([
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'dart',
  'go',
  'html',
  'java',
  'javascript',
  'js',
  'json',
  'json5',
  'jsonc',
  'jsx',
  'kotlin',
  'php',
  'python',
  'rb',
  'ruby',
  'rust',
  'shell',
  'sh',
  'sql',
  'swift',
  'plain',
  'plaintext',
  'text',
  'txt',
  'tsx',
  'ts',
  'typescript',
  'xml',
  'yaml',
  'yml',
]);

const CODE_LIKE_LINE_RE = /^\s*(?:[{[}\](),;]|\/\/|\/\*|\*\/|#|<[\w!/]|[$>]\s|(?:async\s+)?(?:const|let|var|function|class|import|export|from|def|return|if|for|while|switch|try|catch|package|public|private|protected|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b)/;
const SHELL_COMMAND_LINE_RE = /^\s*(?:#|[$>]\s|[A-Za-z_][A-Za-z0-9_]*=|[a-z0-9_.-]+(?:\s|$)|\.\/|~\/|\/)/;
const TEXT_DIAGRAM_LINE_RE = /(?:->|=>|-->|==>|[↓↑←→↔⇄⇆│├└┌┐┘┤┬┴┼─━]|^\s{2,}\S)/;
const TEXT_CONNECTOR_ONLY_LINE_RE = /^\s*(?:->|=>|-->|==>|[↓↑←→↔⇄⇆│├└┌┐┘┤┬┴┼─━])+\s*$/;

function isFenceLine(line: string): boolean {
  return FENCE_LINE_RE.test(line);
}

function findClosingFenceLine(lines: string[], startIndex: number): number {
  const opener = lines[startIndex].trim().slice(0, 3);
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith(opener)) return index;
  }
  return lines.length - 1;
}

function parseLanguageLine(line: string): string | null {
  const match = line.trim().match(LANGUAGE_LINE_RE);
  const language = match?.[1]?.toLowerCase() ?? null;
  return language && LOOSE_CODE_LANGUAGE_IDS.has(language) ? language : null;
}

function looksLikeCodeStart(line: string, language: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (JSON_LANGUAGE_IDS.has(language)) {
    return trimmed.startsWith('{') ||
      trimmed.startsWith('[') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*');
  }

  if (SHELL_LANGUAGE_IDS.has(language)) {
    return SHELL_COMMAND_LINE_RE.test(line);
  }

  return CODE_LIKE_LINE_RE.test(line);
}

function looksLikeTextDiagramLine(line: string): boolean {
  return TEXT_DIAGRAM_LINE_RE.test(line);
}

function updateBraceBalance(line: string, balance: number): number {
  let next = balance;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === '{' || char === '[') next += 1;
    if (char === '}' || char === ']') next -= 1;
  }

  return next;
}

function collectJsonLooseCodeBlock(lines: string[], startIndex: number): number | null {
  let sawOpeningBrace = false;
  let balance = 0;

  for (let index = startIndex; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed && !sawOpeningBrace) continue;
    if (!trimmed && sawOpeningBrace && balance <= 0) return index - 1;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      sawOpeningBrace = true;
    }

    balance = updateBraceBalance(lines[index], balance);

    if (sawOpeningBrace && balance <= 0) {
      return index;
    }
  }

  return sawOpeningBrace ? lines.length - 1 : null;
}

function collectGenericLooseCodeBlock(lines: string[], startIndex: number, language: string): number | null {
  let endIndex = startIndex;
  let codeLineCount = 0;
  let pendingBlankStart: number | null = null;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      if (codeLineCount > 0 && pendingBlankStart === null) {
        pendingBlankStart = index;
      }
      continue;
    }

    if (codeLineCount > 0 && !looksLikeCodeStart(line, language) && !/^\s+/.test(line)) {
      break;
    }

    endIndex = index;
    codeLineCount += 1;
    pendingBlankStart = null;
  }

  return codeLineCount > 0
    ? pendingBlankStart === null ? endIndex : pendingBlankStart - 1
    : null;
}

function collectTextLooseCodeBlock(lines: string[], startIndex: number): number | null {
  let endIndex = startIndex;
  let codeLineCount = 0;
  let pendingBlankStart: number | null = null;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const previousLine = lines[index - 1] ?? '';
    const nextLine = lines[index + 1] ?? '';
    const isDiagramLine = looksLikeTextDiagramLine(line);
    const isNodeBeforeConnector = !!trimmed && looksLikeTextDiagramLine(nextLine);
    const isNodeAfterConnector = !!trimmed && TEXT_CONNECTOR_ONLY_LINE_RE.test(previousLine);

    if (!trimmed) {
      if (codeLineCount > 0 && pendingBlankStart === null) {
        pendingBlankStart = index;
      }
      continue;
    }

    if (!isDiagramLine && !isNodeBeforeConnector && !isNodeAfterConnector) {
      break;
    }

    endIndex = index;
    codeLineCount += 1;
    pendingBlankStart = null;
  }

  return codeLineCount > 0
    ? pendingBlankStart === null ? endIndex : pendingBlankStart - 1
    : null;
}

function collectLooseCodeBlockEnd(lines: string[], languageLineIndex: number, language: string): number | null {
  const codeStartIndex = languageLineIndex + 1;
  const firstCodeLine = lines[codeStartIndex];
  if (firstCodeLine === undefined) {
    return null;
  }

  if (TEXT_LANGUAGE_IDS.has(language)) {
    return collectTextLooseCodeBlock(lines, codeStartIndex);
  }

  if (!looksLikeCodeStart(firstCodeLine, language)) return null;

  if (JSON_LANGUAGE_IDS.has(language)) {
    return collectJsonLooseCodeBlock(lines, codeStartIndex);
  }

  return collectGenericLooseCodeBlock(lines, codeStartIndex, language);
}

function createCandidate(lines: string[], languageLineIndex: number, language: string): CodeBlockCandidate | null {
  const endLine = collectLooseCodeBlockEnd(lines, languageLineIndex, language);
  if (endLine === null) return null;

  return {
    startLine: languageLineIndex,
    endLine,
    language,
    confidence: JSON_LANGUAGE_IDS.has(language) ? 0.95 : 0.85,
  };
}

function fenceCodeBlock(language: string, code: string): string {
  return `\`\`\`${language}\n${code.replace(/\s+$/g, '')}\n\`\`\``;
}

export function detectLooseCodeBlocks(text: string): CodeBlockCandidate[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const candidates: CodeBlockCandidate[] = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (isFenceLine(lines[index])) {
      index = findClosingFenceLine(lines, index);
      continue;
    }

    const language = parseLanguageLine(lines[index]);
    const candidate = language ? createCandidate(lines, index, language) : null;

    if (candidate) {
      candidates.push(candidate);
      index = candidate.endLine;
    }
  }

  return candidates;
}

export function containsLooseCodeBlock(text: string): boolean {
  return detectLooseCodeBlocks(text).length > 0;
}

export function normalizeLooseCodeBlocks(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const candidates = detectLooseCodeBlocks(normalized);
  const candidateByStartLine = new Map(candidates.map(candidate => [candidate.startLine, candidate]));
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (isFenceLine(lines[index])) {
      const endIndex = findClosingFenceLine(lines, index);
      output.push(...lines.slice(index, endIndex + 1));
      index = endIndex;
      continue;
    }

    const candidate = candidateByStartLine.get(index);
    if (candidate) {
      output.push(fenceCodeBlock(
        candidate.language,
        lines.slice(candidate.startLine + 1, candidate.endLine + 1).join('\n'),
      ));
      index = candidate.endLine;
      continue;
    }

    output.push(lines[index]);
  }

  return output.join('\n');
}
