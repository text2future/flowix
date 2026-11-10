#!/usr/bin/env node
// 同步 Microsoft Fluent Emoji (Flat) 到
//   app/flowix-web/assets/property-icons/emoji/<category>/<id>.svg
//
// (Mochi 贴纸包走 scripts/sync-mochi-icons.mjs, 两者共用
//  property-icons/<pack>/<category>/<id>.svg 的目录契约。)
//
// ── 为什么需要这个脚本 ──
// 属性面板「图标」类型用的是一套本地彩色 emoji SVG, 上游是
// microsoft/fluentui-emoji 的 Flat 变体。手工找图 / 转存容易出错, 且
// 每个图标都要带分类 (CLDR group) 才能在 picker 里分组展示。
//
// ── 用法 ──
//   node scripts/sync-property-icons.mjs                  # 同步 (默认排除人物角色/旗帜)
//   node scripts/sync-property-icons.mjs --dry-run        # 只打印计划, 不写盘
//   node scripts/sync-property-icons.mjs --source <dir>   # 复用已克隆的上游目录
//   node scripts/sync-property-icons.mjs --include-people # 连人物角色一起同步
//
// ── 上游目录结构 (注意: 有肤色变体的 emoji 多了一层 <SkinTone>) ──
//   assets/<Name>/metadata.json                          # 含 cldr / group / keywords
//   assets/<Name>/Flat/<slug>_flat.svg                   # 无肤色变体
//   assets/<Name>/Default/Flat/<slug>_flat_default.svg   # 有肤色变体时取 Default
//
// ── 输出契约 (前端依赖, 改之前先看 property-icons.ts) ──
//   * 一级子目录 = 图标包 (本脚本只写 emoji 包), 二级子目录 = 分类 id
//     (kebab-case), 顺序见 GROUP_ORDER;
//   * 文件名去掉扩展名 = 图标 id, 也是 frontmatter properties.icon 里存的值;
//   * 已经存在的同名文件保持原样不动 (现有 164 个是人工压缩过的, 避免无谓 diff)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_URL = 'https://github.com/microsoft/fluentui-emoji.git';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TARGET_DIR = path.join(ROOT, 'app/flowix-web/assets/property-icons/emoji');

// CLDR group → 分类 id。顺序即 picker 里的展示顺序 (与 Unicode 标准分组一致)。
const GROUP_ORDER = [
  ['Smileys & Emotion', 'smileys-emotion'],
  ['People & Body', 'people-body'],
  ['Animals & Nature', 'animals-nature'],
  ['Food & Drink', 'food-drink'],
  ['Travel & Places', 'travel-places'],
  ['Activities', 'activities'],
  ['Objects', 'objects'],
  ['Symbols', 'symbols'],
];
const CATEGORY_BY_GROUP = new Map(GROUP_ORDER);
const CATEGORY_ORDER = GROUP_ORDER.map(([, id]) => id);

// 人物角色: 名字以这些词开头的整族排除 (Man*/Woman*/Person*/Boy/Girl/Baby/...)。
const HUMAN_PREFIX = /^(man|woman|person|boy|girl|baby|child|older|old|people)\b/i;
// 中性职业 / 人物实体: 名字里没有性别前缀, 但本质仍是「人」。
const HUMAN_ENTITIES = new Set([
  'artist', 'astronaut', 'baby angel', 'breast feeding', 'bust in silhouette',
  'busts in silhouette', 'construction worker', 'cook', 'detective',
  'factory worker', 'farmer', 'firefighter', 'guard', 'health worker',
  'horse racing', 'judge', 'mechanic', 'mrs claus', 'mx claus', 'ninja',
  'office worker', 'pilot', 'police officer', 'prince', 'princess',
  'santa claus', 'scientist', 'singer', 'skier', 'snowboarder',
  'speaking head', 'student', 'teacher', 'technologist', 'troll',
]);
// 手势 / 身体部位: 名字命中这些词的一律保留 ( thumbs up / waving hand / ear / brain …)。
const KEEP_BODY_PARTS = /(hand|finger|fist|thumb|biceps|arm|leg|foot|footprints|ear|eye|eyes|nose|mouth|tongue|tooth|bone|brain|lungs|heart|nail|selfie|horns|salute|gesture|lip)/i;

// 产品决定: 这些图标不在属性 picker 里提供 (纯白/空腔形状在浅色背景上不可见,
// 其余为观感不佳), 同步时跳过, 资产目录里也不保留。
const EXCLUDED_ICON_IDS = new Set([
  'tooth', 'speech-balloon', 'left-speech-bubble', 'worm',
  'white-circle', 'white-large-square', 'white-medium-square',
  'white-medium-small-square', 'white-small-square',
]);

function parseArgs(argv) {
  const args = new Set(argv);
  const readValue = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };
  return {
    dryRun: args.has('--dry-run'),
    includePeople: args.has('--include-people'),
    source: readValue('--source'),
  };
}

/** 克隆上游 (blobless + sparse, 只拉 metadata.json 与 Flat svg)。 */
function ensureUpstream(sourceArg) {
  if (sourceArg) {
    if (!fs.existsSync(path.join(sourceArg, 'assets'))) {
      throw new Error(`--source 目录里没有 assets/: ${sourceArg}`);
    }
    return sourceArg;
  }
  const dir = path.join(os.tmpdir(), 'flowix-fluent-emoji');
  if (!fs.existsSync(path.join(dir, 'assets'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`· 克隆上游到 ${dir} …`);
    execFileSync('git', [
      'clone', '--depth', '1', '--filter=blob:none', '--sparse', REPO_URL, dir,
    ], { stdio: 'inherit' });
    // HTTP/1.1: HTTP2 framing 在这台机器上偶发失败。
    execFileSync('git', ['-C', dir, 'config', 'http.version', 'HTTP/1.1']);
  }
  execFileSync('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone',
    'assets/*/metadata.json', 'assets/*/Flat/*.svg', 'assets/*/Default/Flat/*.svg'],
  { stdio: 'inherit' });
  return dir;
}

/** 数字精度压到 3 位并去掉尾随 0 (对齐现有文件的压缩风格)。 */
function roundNumbers(value) {
  return value.replace(/-?\d*\.\d+/g, (match) => {
    const rounded = Number(match).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return rounded === '-0' ? '0' : rounded;
  });
}

/** 把上游 SVG 压成 <svg viewBox><g fill="none">…</g></svg>。 */
function minifySvg(raw) {
  let svg = raw
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    .replace(/<desc[\s\S]*?<\/desc>/gi, '')
    .trim();

  const open = svg.match(/<svg\b[^>]*>/i);
  const close = svg.lastIndexOf('</svg>');
  if (!open || close < 0) throw new Error('不是可识别的 SVG');
  const attrs = open[0];
  const viewBox = attrs.match(/viewBox\s*=\s*"([^"]+)"/i)?.[1] ?? '0 0 32 32';
  let inner = svg.slice(open.index + open[0].length, close);

  inner = inner
    .replace(/(?<=>)\s+(?=<)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+</g, '<')
    .replace(/>\s+/g, '>')
    .trim();

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><g fill="none">${roundNumbers(inner)}</g></svg>`;
}

function toKebab(value) {
  return value
    .replace(/[&]+/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 图标 id: 取上游 svg 文件名, 去掉 _flat / _flat_default 后缀并转 kebab。 */
function iconIdFromFileName(fileName) {
  return toKebab(fileName.replace(/\.svg$/i, '').replace(/_flat(_default)?$/i, ''));
}

function findUpstreamSvg(folderDir, name) {
  const direct = path.join(folderDir, 'Flat');
  if (fs.existsSync(direct)) {
    const hit = fs.readdirSync(direct).find((file) => file.endsWith('.svg'));
    if (hit) return path.join(direct, hit);
  }
  const defaultDir = path.join(folderDir, 'Default', 'Flat');
  if (fs.existsSync(defaultDir)) {
    const hit = fs.readdirSync(defaultDir).find((file) => file.endsWith('.svg'));
    if (hit) return path.join(defaultDir, hit);
  }
  return null;
}

function isHumanRole(name) {
  if (KEEP_BODY_PARTS.test(name)) return false;
  if (HUMAN_PREFIX.test(name)) return true;
  return HUMAN_ENTITIES.has(name.toLowerCase());
}

function main() {
  const { dryRun, includePeople, source } = parseArgs(process.argv.slice(2));
  const upstream = ensureUpstream(source);
  const assetsDir = path.join(upstream, 'assets');

  const planned = [];
  const skipped = {
    flags: 0, people: 0, noSvg: 0, noMetadata: 0, unknownGroup: 0, excluded: 0,
  };
  const byCategory = new Map(CATEGORY_ORDER.map((id) => [id, []]));

  for (const name of fs.readdirSync(assetsDir)) {
    const folderDir = path.join(assetsDir, name);
    if (!fs.statSync(folderDir).isDirectory()) continue;
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(folderDir, 'metadata.json'), 'utf8'));
    } catch {
      skipped.noMetadata += 1;
      continue;
    }
    const group = meta.group;
    const category = CATEGORY_BY_GROUP.get(group);
    if (!category) {
      // Flags 等未列入 GROUP_ORDER 的分组整体跳过。
      if (group === 'Flags') skipped.flags += 1; else skipped.unknownGroup += 1;
      continue;
    }
    if (!includePeople && group === 'People & Body' && isHumanRole(name)) {
      skipped.people += 1;
      continue;
    }
    const svgPath = findUpstreamSvg(folderDir, name);
    if (!svgPath) {
      skipped.noSvg += 1;
      continue;
    }
    const id = iconIdFromFileName(path.basename(svgPath));
    if (EXCLUDED_ICON_IDS.has(id)) {
      skipped.excluded += 1;
      continue;
    }
    planned.push({ id, name, group, category, svgPath, label: meta.cldr ?? name });
    byCategory.get(category).push(id);
  }

  planned.sort((a, b) => a.id.localeCompare(b.id));

  const report = CATEGORY_ORDER.map((id) => ({ id, count: byCategory.get(id).length }));
  console.log('· 计划写入:', planned.length, '个图标');
  for (const entry of report) console.log(`    ${entry.id.padEnd(16)} ${entry.count}`);
  console.log('· 跳过:', JSON.stringify(skipped));

  if (dryRun) return;

  for (const category of CATEGORY_ORDER) {
    fs.mkdirSync(path.join(TARGET_DIR, category), { recursive: true });
  }

  let written = 0;
  let preserved = 0;
  for (const item of planned) {
    const target = path.join(TARGET_DIR, item.category, `${item.id}.svg`);
    if (fs.existsSync(target)) {
      // 已存在 (含历史上人工压缩过的) 原样保留, 避免无谓 diff。
      preserved += 1;
      continue;
    }
    fs.writeFileSync(target, minifySvg(fs.readFileSync(item.svgPath, 'utf8')));
    written += 1;
  }

  console.log(`· 新写入 ${written} 个, 保留已有 ${preserved} 个`);
}

main();
