#!/usr/bin/env node
// scripts/check-rust-architecture.mjs
//
// Rust 侧架构门禁。与前端 `check-architecture.mjs` 同一套「策略 + 基线」形态：
// 规则来自 rust-architecture.config.json，不来自本文件里的路径清单；
// 存量违规记在 rust-architecture-baseline.json，新增直接失败、基线只减不增。
//
// 为什么需要它：前端有 8 个 check 脚本 + pre-commit，Rust 侧此前只有 workspace
// 依赖表。98k 行的 flowix-desktop 内部零方向约束，`commands ↔ watcher` 已经
// 互指 42/19 处。四类规则：
//
//   1. crateDependencies  ── 域 crate 不得依赖 tauri / 不得反向依赖壳
//   2. forbiddenModuleEdges ── crate 内声明的回边（当前存量进基线）
//   3. maxFileLines       ── 单文件行数上限
//   4. gravity            ── 壳/域行数比，只减不增（重心倒置的唯一量化指标）
//
// 用法：
//   node scripts/check-rust-architecture.mjs              # 检查
//   node scripts/check-rust-architecture.mjs --matrix     # 附带模块依赖矩阵
//   node scripts/check-rust-architecture.mjs --update-baseline
//
// 测试豁免（回边与 crate 依赖）：`tests.rs`、`*_tests.rs`、`tests/` 下的文件，
// 以及非测试文件里顶格的 `#[cfg(test)]` 项。`cfg(test)` 不参与生产编译，也就
// 不构成生产依赖；唯一的例外是行数规则 —— 它看文件实际大小，测试也算。
//
// 回边按两种写法分别解析：`crate::xxx` 取第一段；`super::…::xxx` 按文件所在的
// 模块深度回溯到父模块再取第一段。剩下的盲区只有一个 —— `use super::*` 与
// `use super::{a, b}` 不含模块名，无法静态判定，改这类导入时仍需人看一眼。

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../app', import.meta.url));
const CONFIG = fileURLToPath(new URL('../rust-architecture.config.json', import.meta.url));
const BASELINE = fileURLToPath(new URL('../rust-architecture-baseline.json', import.meta.url));

const updateBaseline = process.argv.includes('--update-baseline');
const printMatrix = process.argv.includes('--matrix');

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const CRATE_REF_RE = /\bcrate::([a-z_][a-z0-9_]*)/g;
// `super::super::commands` 这类相对写法也必须算作回边，否则改动只要绕开
// `crate::` 前缀就能静默通过 —— 尤其是 watcher→commands 这条零容忍规则。
const SUPER_REF_RE = /\bsuper::((?:super::)*)([a-z_][a-z0-9_]*)/g;

const isTestFile = (path) =>
  /(^|\/)tests\.rs$/.test(path)
  || /_tests\.rs$/.test(path)
  || /(^|\/)tests\//.test(path);

/**
 * 去掉 `#[cfg(test)]` 项（`mod tests` 块，或带该属性的单个函数/结构）。
 *
 * `cfg(test)` 的代码不参与生产编译，也就不构成生产依赖。之前只豁免「测试文件」，
 * 于是同一个测试写进 `watcher/tests.rs` 不算违规、内联在 `watcher/manager.rs`
 * 里就算 —— 口径不一致，而且会逼着人为了过检查去挪测试。
 *
 * 收尾靠**花括号配平**，不靠「第一个顶格 `}`」：`impl` 里带 `#[cfg(test)]` 的
 * 方法（`tombstone.rs::contains_for_test`）右花括号是缩进的，按顶格判断会把整个
 * `impl` 的尾巴一起当测试剥掉，那些行里的真实依赖就再也扫不到 —— 门禁静默失明，
 * 比误报严重。声明型项（`mod tests;`、`use a::b;`）没有花括号，吃到分号为止。
 *
 * 行数统计仍用**完整源码**——超限规则看的是文件实际大小，不因为含测试而放水。
 */
function stripCfgTestItems(source) {
  if (!source.includes('#[cfg(test)]')) return source;
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '#[cfg(test)]') {
      out.push(lines[i]);
      continue;
    }
    // 跳过与 `#[cfg(test)]` 相邻的其它属性，定位到项本身的第一行。
    let end = i + 1;
    while (end < lines.length && lines[end].trim().startsWith('#[')) end += 1;
    let depth = 0;
    for (; end < lines.length; end += 1) {
      const line = lines[end];
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (depth > 0) continue;
      // 配平回到 0：`…;` 是声明型结尾，`…}`（含 `};`、缩进的 `    }`）是块型结尾。
      const tail = line.trimEnd();
      if (tail.endsWith(';') || tail.endsWith('}')) break;
    }
    // 留一行空行占位，避免把两个相邻项粘在一起。
    out.push('');
    i = end;
  }
  return out.join('\n');
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (entry.endsWith('.rs')) acc.push(path);
  }
  return acc;
}

/** 模块 = src/ 下的第一段路径；直接位于 src/ 的文件取自身文件名。 */
function moduleOf(crate, file) {
  const parts = relative(join(APP, crate, 'src'), file).split(/[\\/]/);
  return parts.length > 1 ? parts[0] : parts[0].replace(/\.rs$/, '');
}

/** 文件对应的模块路径（不含 crate 前缀），用于把 `super::` 链换算成绝对模块。 */
function moduleSegmentsOf(crate, file) {
  const parts = relative(join(APP, crate, 'src'), file).split(/[\\/]/);
  const last = parts[parts.length - 1];
  if (last === 'mod.rs' || last === 'lib.rs' || last === 'main.rs') {
    return parts.slice(0, -1);
  }
  return [...parts.slice(0, -1), last.replace(/\.rs$/, '')];
}

/** 只解析依赖相关 section，避免 [build-dependencies] 里的 tauri-build 之类误判。 */
function declaredDependencies(crate) {
  const path = join(APP, crate, 'Cargo.toml');
  if (!existsSync(path)) return [];
  const names = [];
  let inDeps = false;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inDeps = /(^|\.)dependencies$/.test(line.replace(/[[\]]/g, ''));
      continue;
    }
    if (!inDeps || !line || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

// ── 采集 ────────────────────────────────────────────────────────────────────

const shells = config.gravity?.shell ? [config.gravity.shell] : [];
const crates = [...new Set([
  ...Object.keys(config.crateDependencies ?? {}),
  ...(config.forbiddenModuleEdges ?? []).map((edge) => edge.crate),
  ...shells,
  ...(config.gravity?.domain ? [config.gravity.domain] : []),
])];

const edges = new Map(); // `${crate}:${from}->${to}` -> count
const lines = new Map(); // `${crate}/src/...` -> lines
const crateLines = new Map();

for (const crate of crates) {
  for (const file of walk(join(APP, crate, 'src'))) {
    const rel = relative(APP, file).split(/[\\/]/).join('/');
    const source = readFileSync(file, 'utf8');
    // 用换行数而非 split 长度，保证与 `wc -l` / 编辑器显示一致。
    const lineCount = (source.match(/\n/g) ?? []).length;
    const isTest = isTestFile(rel.replace(/^app\//, ''));
    if (!isTest) {
      lines.set(rel, lineCount);
      crateLines.set(crate, (crateLines.get(crate) ?? 0) + lineCount);
    }

    const from = moduleOf(crate, file);
    if (isTest) continue;
    const production = stripCfgTestItems(source);
    const record = (to) => {
      if (to === from) return;
      const key = `${crate}:${from}->${to}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    };
    for (const match of production.matchAll(CRATE_REF_RE)) {
      record(match[1]);
    }
    const segments = moduleSegmentsOf(crate, file);
    for (const match of production.matchAll(SUPER_REF_RE)) {
      const hops = 1 + (match[1].match(/super::/g)?.length ?? 0);
      if (hops > segments.length) continue; // 越界写法编译期就报错，静态扫描忽略
      const resolved = [...segments.slice(0, segments.length - hops), match[2]];
      record(resolved[0]);
    }
  }
}

// ── 规则 ────────────────────────────────────────────────────────────────────

const violations = [];
const observed = { crateDeps: {}, edges: {}, fileLines: {}, gravity: null };

for (const [crate, rule] of Object.entries(config.crateDependencies ?? {})) {
  const declared = declaredDependencies(crate);
  for (const forbidden of rule.forbidden ?? []) {
    if (declared.includes(forbidden)) {
      observed.crateDeps[`${crate}->${forbidden}`] = true;
      violations.push({
        kind: 'crate-dependency',
        key: `${crate} -> ${forbidden}`,
        detail: rule.why,
      });
    }
  }
}

for (const edge of config.forbiddenModuleEdges ?? []) {
  const key = `${edge.crate}:${edge.from}->${edge.to}`;
  const count = edges.get(key) ?? 0;
  observed.edges[key] = count;
}

const maxFileLines = config.maxFileLines ?? Number.POSITIVE_INFINITY;
for (const [rel, count] of lines) {
  if (count > maxFileLines) observed.fileLines[rel] = count;
}

if (config.gravity?.shell && config.gravity?.domain) {
  const shell = crateLines.get(config.gravity.shell) ?? 0;
  const domain = crateLines.get(config.gravity.domain) ?? 1;
  observed.gravity = Math.round((shell / domain) * 100) / 100;
}
const gravityTolerance = config.gravity?.tolerance ?? 0.02;

const baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, 'utf8'))
  : { edges: {}, fileLines: {}, gravity: null };

// 基线记录现状，config 的 maxRatio 表达「想压到多少」；取更严的一个作上限。
const gravityCeiling = Math.min(
  config.gravity?.maxRatio ?? Number.POSITIVE_INFINITY,
  baseline.gravity ?? Number.POSITIVE_INFINITY,
);
const gravityCeilingLabel = Number.isFinite(gravityCeiling) ? gravityCeiling : null;

if (updateBaseline) {
  // 收紧基线和「顺手放行新违规」看起来是同一条命令，必须把后者显式打出来 ——
  // 否则一次 --update-baseline 就能让回边和超限文件静默上涨。
  const grownEdges = Object.entries(observed.edges)
    .filter(([key, count]) => count > (baseline.edges?.[key] ?? 0));
  const grownFiles = Object.entries(observed.fileLines)
    .filter(([rel, count]) => count > (baseline.fileLines?.[rel] ?? maxFileLines));
  writeFileSync(BASELINE, `${JSON.stringify(observed, null, 2)}\n`);
  console.log(
    `✓ Rust 架构基线已更新：${Object.keys(observed.edges).length} 条回边、`
    + `${Object.keys(observed.fileLines).length} 个超限文件、重心比 ${observed.gravity ?? 'n/a'}`,
  );
  if (grownEdges.length > 0 || grownFiles.length > 0) {
    console.log('  ⚠ 这次同时写入了新增违规（无法用「删除存量」解释，请确认是否是有意为之）：');
    for (const [key, count] of grownEdges) {
      console.log(`    + 回边 ${key}：${baseline.edges?.[key] ?? 0} → ${count}`);
    }
    for (const [rel, count] of grownFiles) {
      console.log(`    + 文件 ${rel}：${count} 行`);
    }
  }
  process.exit(0);
}

const edgeGrowth = [];
const tightenedEdges = [];
for (const [key, count] of Object.entries(observed.edges)) {
  const allowed = baseline.edges?.[key] ?? 0;
  if (count > allowed) edgeGrowth.push({ key, count, allowed });
  else if (count < allowed) tightenedEdges.push({ key, count, allowed });
}

const fileGrowth = [];
const tightenedFiles = [];
for (const [rel, count] of Object.entries(observed.fileLines)) {
  const allowed = baseline.fileLines?.[rel];
  if (allowed === undefined) fileGrowth.push({ rel, count, allowed: maxFileLines });
  else if (count > allowed) fileGrowth.push({ rel, count, allowed });
  else if (count < allowed) tightenedFiles.push({ rel, count, allowed });
}
for (const [rel, count] of Object.entries(baseline.fileLines ?? {})) {
  if (!(rel in observed.fileLines)) tightenedFiles.push({ rel, count: 0, allowed: count });
}

const gravityGrowth = gravityCeiling !== null
  && observed.gravity !== null
  && observed.gravity > gravityCeiling * (1 + gravityTolerance);
const gravityTightened = baseline.gravity !== null
  && observed.gravity !== null
  && observed.gravity < baseline.gravity * (1 - gravityTolerance);

const failed = violations.length > 0 || edgeGrowth.length > 0
  || fileGrowth.length > 0 || gravityGrowth;

if (failed) {
  console.error('\n❌ Rust 架构违规\n');
  for (const item of violations) {
    console.error(`  + 依赖 ${item.key}`);
    if (item.detail) console.error(`    ${item.detail}`);
  }
  for (const item of edgeGrowth) {
    console.error(`  + 回边 ${item.key}：${item.allowed} → ${item.count} 处`);
  }
  for (const item of fileGrowth) {
    console.error(`  + 文件 ${item.rel}：上限 ${item.allowed} 行，当前 ${item.count} 行`);
  }
  if (gravityGrowth) {
    console.error(
      `  + 重心比 ${config.gravity.shell}/${config.gravity.domain}：`
      + `上限 ${gravityCeilingLabel} → 当前 ${observed.gravity}（壳在变胖）`,
    );
  }
  console.error(
    '\n修复方向：把命令体下沉到 flowix-core，commands 只留 IPC 适配；'
    + 'watcher 需要的对账逻辑跟着下沉，不要反向调 commands。\n'
    + '禁止用 --update-baseline 放行新违规；只有删除存量时才允许收紧基线。\n',
  );
  process.exit(1);
}

if (printMatrix) {
  console.log('\n模块依赖矩阵（crate 内，含测试文件以外）：');
  for (const [key, count] of [...edges.entries()].sort((a, b) => b[1] - a[1])) {
    const forbidden = (config.forbiddenModuleEdges ?? [])
      .some((edge) => `${edge.crate}:${edge.from}->${edge.to}` === key);
    console.log(`  ${String(count).padStart(4)}  ${key}${forbidden ? '   ← 已声明禁止' : ''}`);
  }
  console.log('');
}

console.log(
  `✓ Rust 架构检查通过（回边存量 ${Object.values(observed.edges).reduce((a, b) => a + b, 0)} 处 / `
  + `${Object.keys(observed.edges).length} 条规则，超限文件 ${Object.keys(observed.fileLines).length} 个，`
  + `重心比 ${observed.gravity ?? 'n/a'}）`,
);
if (tightenedEdges.length > 0 || tightenedFiles.length > 0 || gravityTightened) {
  console.log(
    `  可收紧基线：${tightenedEdges.length} 条回边、${tightenedFiles.length} 个文件`
    + `${gravityTightened ? '、重心比' : ''}已下降`
    + '（跑 node scripts/check-rust-architecture.mjs --update-baseline）',
  );
}
