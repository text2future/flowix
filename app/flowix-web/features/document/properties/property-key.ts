import { ensurePinyin, type PinyinFn } from '@/lib/pinyin';

const KNOWN_PROPERTY_KEYS: Readonly<Record<string, string>> = {
  type: 'type',
  kind: 'type',
  leixing: 'type',
  shifou: 'boolean',
  'shi-fou': 'boolean',
  icon: 'icon',
  tubiao: 'icon',
  'ref-url': 'ref-url',
  'reference-url': 'ref-url',
  cankaourl: 'ref-url',
  keywords: 'keywords',
  keyword: 'keywords',
  guanjianchi: 'keywords',
  status: 'status',
  zhuangtai: 'status',
  priority: 'priority',
  youxianji: 'priority',
  'due-date': 'due-date',
  'jiezhi-riqi': 'due-date',
  'jie-zhi-ri-qi': 'due-date',
  jiezhiriqi: 'due-date',
  deadline: 'due-date',
  'start-date': 'start-date',
  'kaishi-riqi': 'start-date',
  'kai-shi-ri-qi': 'start-date',
  kaishiriqi: 'start-date',
  owner: 'owner',
  fuzeren: 'owner',
  assignee: 'assignee',
  biaoqian: 'tags',
  tag: 'tags',
  tags: 'tags',
};

export function canonicalizePropertyKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.toLowerCase() === 'tag' ? 'tags' : trimmed;
}

function normalizeKnownKeyInput(value: string, pinyin: PinyinFn): string[] {
  const trimmed = value.trim();
  const withoutSpaces = trimmed.replace(/\s+/g, '');
  const pinyinKey = pinyin(withoutSpaces, { toneType: 'none' })
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return [
    trimmed.toLowerCase().replace(/[_\s]+/g, '-').replace(/^-+|-+$/g, ''),
    withoutSpaces.toLowerCase(),
    pinyinKey,
    pinyinKey.replace(/-/g, ''),
  ].filter(Boolean);
}

function splitAsciiToken(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// 改为 async: 中文属性名需 pinyin-pro 转写, 模块动态加载 (独立 chunk)。
// 调用方 (note-properties-dialog 的 addCustomField / updateRowFromEdit) 已改 async。
export async function generatePropertyKey(displayName: string): Promise<string> {
  const name = displayName.trim();
  if (!name) return '';

  const pinyin = await ensurePinyin();

  for (const candidate of normalizeKnownKeyInput(name, pinyin)) {
    const known = KNOWN_PROPERTY_KEYS[candidate];
    if (known) return known;
  }

  const tokens: string[] = [];
  let asciiBuffer = '';

  const flushAscii = () => {
    if (!asciiBuffer) return;
    tokens.push(...splitAsciiToken(asciiBuffer));
    asciiBuffer = '';
  };

  for (const char of Array.from(name)) {
    if (/[\p{Script=Han}]/u.test(char)) {
      flushAscii();
      const py = pinyin(char, { toneType: 'none' })
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
      if (py) tokens.push(py);
      continue;
    }

    if (/[a-zA-Z0-9]/.test(char)) {
      asciiBuffer += char;
      continue;
    }

    flushAscii();
  }

  flushAscii();
  return tokens.join('-') || 'property';
}
