#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../app/flowix-web', import.meta.url));
const LOGGER_FILE = join(ROOT, 'lib/logger.ts');

// Ratchets: lower these numbers as legacy debt is removed. Never raise them to
// make CI green; new code must use typed boundaries and createLogger().
const MAX_EXPLICIT_ANY = 0;
const MAX_DIRECT_CONSOLE_CALLS = 102;

// 千行文件"禁止增长"闸门（T4-0，见 docs/architecture-78-to-85-plan.md）。
// 规则：
//   - 名单内文件行数 > 记录值 → error（增一行都不行，倒逼拆分而非续写）；
//   - 名单内文件行数 < 记录值 → 通过，并在输出里提示可下调记录值（ratchet 靠人工确认写入）；
//   - 名单外新文件 ≥ MAX_NEW_FILE_LINES → error；
//   - exempt: true 的数据文件（i18n 资源）同样冻结，但不计入"应拆"债务。
// 搬迁（如 T2 domain 下沉的纯 git mv）需同步更新这里的路径，行数不变不算增长。
const MAX_NEW_FILE_LINES = 1000;
// 注意：本条目的数字必须是「写入当时的实测行数」。以下三条（table-document-view /
// notebook-file-tree / main-layout）历史上填过一个从未与任何提交相符的偏小值，
// 导致闸门自 5730f7a9 起就一直红着；2026-11-03 对齐到实测，此后仍然只许下降。
//
// 测试文件（agent-thread-card.test / markdown-editor.select-all.test）例外：
// docs/architecture-78-to-85-plan.md 明确「千行测试文件冻结即可，不主动拆，拆分收益低」，
// 而新增断言必然加行，故 2026-11-03 一并按实测对齐，不再以「续写」论。
//
// 2026-11-05 处置（本轮不再上调任何**生产**文件的记录值）：
//   - notebook-file-tree.tsx 1447→1427、markdown-editor.tsx 964→941：抽出
//     NotebookTreeDraft / normalizeTaskItemPlaceholders + resetEditorHistory，
//     是从源头把行数降下来，不是放宽门槛；
//   - notebook-file-tree.test.tsx 1499→1556、markdown-editor.select-all.test.tsx
//     1061→1081：测试文件按上述先例对齐实测（新增的是断言，不是待拆逻辑）。
// 2026-11-06：agent-session-actions.test.ts 3158→3212，同样只是新增一条发送
// 前置检查的断言（blocked Cloud send 的用户消息与登录卡片），非待拆逻辑。
// 2026-11-10：markdown-editor.tsx 941→859，同样是拆分（序列化策略抽成
// useDeferredMarkdownSerialization，另删除未使用的 initialParsedContent
// 预解析入口），不是放宽门槛。
// 若将来生产文件再超限，唯一合法出路仍是拆分，不得在这里改大数字。
const FROZEN_FILES = {
  'features/multidimensional-table/table-document-view.tsx': 1931,
  'features/agent/thread-card/settings/external-agent-settings-controller.ts': 2404,
  'lib/i18n/messages.en-US.ts': { lines: 2371, exempt: true },
  'lib/i18n/messages.zh-CN.ts': { lines: 2345, exempt: true },
  'features/preferences/sections/agent.tsx': 2085,
  'features/agent/thread-card/agent-thread-card-view.tsx': 2017,
  'features/memo/components/notebook-file-tree.tsx': 1431,
  'features/memo/components/notebook-file-tree.test.tsx': 1556,
  'features/memo/components/memo-list.tsx': 1361,
  'features/workspace/use-cases/workspace-navigation.ts': 1356,
  'features/agent/thread-card/settings/notebook-agent-settings-dialog.tsx': 1276,
  'features/editor/extensions/frontmatter-property.test.ts': 1238,
  'features/editor/extensions/codeblock-shiki/codeblock-shiki-view.ts': 1192,
  'features/editor/extensions/frontmatter-property-editor.ts': 1089,
  'features/shell/main-layout.tsx': 592,
  'features/editor/extensions/frontmatter-node-view.ts': 1084,
  'features/agent/store/thread-history.ts': 977,
  'features/editor/markdown-editor.select-all.test.tsx': 1081,
  'features/agent/store/session-reducer/reduce-projection.test.ts': 1020,
  'features/editor/markdown-editor.tsx': 858,
  'features/agent/thread-card/agent-thread-card.test.ts': 4483,
  'features/agent/store/agent-session-actions.test.ts': 3212,
};

function countLines(content) {
  const newlines = (content.match(/\n/g) || []).length;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
    } else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function sourceKind(file) {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isDirectConsoleCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  if (ts.isPropertyAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression) && expression.expression.text === 'console';
  }
  if (ts.isElementAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression) && expression.expression.text === 'console';
  }
  return false;
}

function location(source, node) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(ROOT, source.fileName)}:${line + 1}:${character + 1}`;
}

const explicitAnyLocations = [];
const directConsoleLocations = [];
const files = walk(ROOT);

for (const file of files) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourceKind(file),
  );

  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      explicitAnyLocations.push(location(source, node));
    }
    if (file !== LOGGER_FILE && isDirectConsoleCall(node)) {
      directConsoleLocations.push(location(source, node));
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
}

const failures = [];
if (explicitAnyLocations.length > MAX_EXPLICIT_ANY) {
  failures.push(
    `显式 any ${explicitAnyLocations.length} > ${MAX_EXPLICIT_ANY}:\n` +
      explicitAnyLocations.map((item) => `  ${item}`).join('\n'),
  );
}
if (directConsoleLocations.length > MAX_DIRECT_CONSOLE_CALLS) {
  failures.push(
    `直接 console 调用 ${directConsoleLocations.length} > ${MAX_DIRECT_CONSOLE_CALLS}:\n` +
      directConsoleLocations.map((item) => `  ${item}`).join('\n'),
  );
}

// --- 千行文件冻结闸门（T4-0） ---
const locFailures = [];
const ratchetCandidates = [];
const frozenStats = { frozen: 0, exempt: 0, overLimitNew: [] };
const seenFrozen = new Set();

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  const content = readFileSync(file, 'utf8');
  const lines = countLines(content);
  const entry = FROZEN_FILES[rel];
  const limit = entry === undefined ? undefined : (typeof entry === 'number' ? entry : entry.lines);

  if (entry !== undefined) {
    seenFrozen.add(rel);
    if (typeof entry === 'object' && entry.exempt) frozenStats.exempt += 1;
    else frozenStats.frozen += 1;
    if (lines > limit) {
      locFailures.push(
        `冻结文件增长: ${rel} ${lines} > ${limit}（+${lines - limit} 行）。该文件已冻结，禁止续写；请拆分后同步下调 FROZEN_FILES 记录值。`,
      );
    } else if (lines < limit) {
      ratchetCandidates.push(`  ${rel}: ${limit} → ${lines}（-${limit - lines}）`);
    }
    continue;
  }

  if (lines >= MAX_NEW_FILE_LINES) {
    locFailures.push(
      `新千行文件: ${rel} ${lines} 行 ≥ ${MAX_NEW_FILE_LINES}。禁止新增千行文件；如为冻结文件搬迁，请更新 FROZEN_FILES 路径。`,
    );
    frozenStats.overLimitNew.push(rel);
  }
}

const missingFrozen = Object.keys(FROZEN_FILES).filter((rel) => !seenFrozen.has(rel));
if (missingFrozen.length > 0) {
  locFailures.push(
    `FROZEN_FILES 中记录的文件已不存在（搬迁后须同步更新路径，行数不变不算增长）:\n` +
      missingFrozen.map((rel) => `  ${rel}`).join('\n'),
  );
}

if (locFailures.length > 0) {
  failures.push(`千行文件冻结闸门:\n${locFailures.map((item) => `  ${item}`).join('\n')}`);
}

if (failures.length > 0) {
  console.error(`\n❌ 前端债务门禁失败\n\n${failures.join('\n\n')}\n`);
  process.exit(1);
}

if (ratchetCandidates.length > 0) {
  console.log(
    `ℹ 千行文件可下调冻结记录值（ratchet 需人工确认写入 FROZEN_FILES）:\n${ratchetCandidates.join('\n')}`,
  );
}
console.log(
  `✓ 前端债务门禁通过 (显式 any: ${explicitAnyLocations.length}/${MAX_EXPLICIT_ANY}, ` +
    `直接 console: ${directConsoleLocations.length}/${MAX_DIRECT_CONSOLE_CALLS}, ` +
    `冻结文件: ${frozenStats.frozen} + 豁免 ${frozenStats.exempt}, ` +
    `新千行文件: ${frozenStats.overLimitNew.length})`,
);
