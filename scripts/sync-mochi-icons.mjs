#!/usr/bin/env node
// 同步 Mochi 贴纸到 app/flowix-web/assets/property-icons/mochi/all/<id>.svg
//
// ── 为什么需要这个脚本 ──
// Mochi sticker 原样是 width/height=24 viewBox="0 0 24 24" 的贴纸, 绘制内容
// 只占画布 62%–87.5% (分散)。而 property-icons 里 Fluent Emoji 全部是
// 32 画布、绘制占 87.5% —— 直接混进去同一行会明显偏小。这里把每张贴纸
// 重烘焙到 32 画布: 按 alpha 包围盒缩放到 target 28/32 并居中。
//
// ── alpha 包围盒 (而不是 getBBox) ──
// 贴纸的灰底/白边是大 stroke, getBBox 不含 stroke 会算小 ~20%。所以用
// @resvg/resvg-js 栅格化后读 alpha 通道求外框, 阈值滤掉不可见的 AA 边缘。
//
// ── 用法 ──
//   node scripts/sync-mochi-icons.mjs --source <放 mochi-*.svg 的目录>
//   node scripts/sync-mochi-icons.mjs --source <dir> --dry-run
//
// ── 输出契约 (前端依赖, 改之前先看 property-icons.ts) ──
//   * pack = mochi, 分类目录固定 all (贴纸不细分, picker 里单分类包不显示分类条);
//   * 文件名去掉扩展名 = 图标 id。源文件名带 mochi- 前缀, 与 emoji 包的 id
//     天然不冲突 (emoji 包里有 cactus/candy/... 重名, 这里靠前缀区分)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TARGET_DIR = path.join(ROOT, 'app/flowix-web/assets/property-icons/mochi/all');
const CANVAS = 32;
const TARGET_DRAW = 28; // Fluent Emoji 的绘制占比 (87.5%)
const RASTER = 512; // 栅格化边长, 求包围盒用
const ALPHA_THRESHOLD = 16; // 0-255, 滤掉不可见的抗锯齿边缘

function parseArgs(argv) {
  const args = new Set(argv);
  const readValue = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };
  return {
    dryRun: args.has('--dry-run'),
    source: readValue('--source'),
  };
}

/** 栅格化并求 alpha 包围盒 (viewBox 24 空间的坐标)。 */
function measureAlphaBBox(svg, rasterSize) {
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: rasterSize },
    background: 'rgba(0,0,0,0)',
  }).render();
  const pixels = rendered.pixels; // RGBA, 长度 = w*h*4
  const width = rendered.width;
  const height = rendered.height;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (pixels[row + x * 4 + 3] <= ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, width, height };
}

/** 去掉外层 <svg> 标签, 保留内部全部节点 (defs/g/...)。 */
function innerSvg(raw) {
  const open = raw.match(/<svg\b[^>]*>/i);
  const close = raw.lastIndexOf('</svg>');
  if (!open || close < 0) throw new Error('不是可识别的 SVG');
  return raw.slice(open.index + open[0].length, close);
}

function buildResizedSvg(raw, box) {
  const scalePxToUnits = 24 / RASTER; // 源 viewBox 是 0 0 24 24
  const w = (box.maxX - box.minX + 1) * scalePxToUnits;
  const h = (box.maxY - box.minY + 1) * scalePxToUnits;
  const x = box.minX * scalePxToUnits;
  const y = box.minY * scalePxToUnits;
  const s = TARGET_DRAW / Math.max(w, h);
  const tx = (CANVAS - w * s) / 2 - x * s;
  const ty = (CANVAS - h * s) / 2 - y * s;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}">`,
    `<g fill="none" transform="translate(${round(tx)} ${round(ty)}) scale(${round(s)})">`,
    innerSvg(raw),
    '</g></svg>',
  ].join('');
}

function round(value) {
  return String(Number(value.toFixed(4)));
}

function main() {
  const { dryRun, source } = parseArgs(process.argv.slice(2));
  if (!source) throw new Error('需要 --source <放 mochi-*.svg 的目录>');
  const files = fs.readdirSync(source)
    .filter((file) => file.startsWith('mochi-') && file.endsWith('.svg'))
    .sort();
  if (files.length === 0) throw new Error(`源目录里没有 mochi-*.svg: ${source}`);

  const plan = [];
  for (const file of files) {
    const id = file.replace(/\.svg$/i, '');
    const raw = fs.readFileSync(path.join(source, file), 'utf8');
    let box = null;
    try {
      box = measureAlphaBBox(raw, RASTER);
    } catch (error) {
      console.warn(`· 跳过 (解析失败 ${error.message}): ${file}`);
      continue;
    }
    if (!box) {
      console.warn(`· 跳过 (全透明): ${file}`);
      continue;
    }
    const drawRatio = Math.max(
      box.maxX - box.minX + 1,
      box.maxY - box.minY + 1,
    ) / RASTER;
    plan.push({ id, raw, box, svg: buildResizedSvg(raw, box), drawRatio });
  }

  const ratios = plan.map((item) => item.drawRatio).sort((a, b) => a - b);
  console.log(`· 计划写入 ${plan.length} 个, 绘制占比 avg=${avg(ratios)} p10=${percentile(ratios, 0.1)} p90=${percentile(ratios, 0.9)}`);
  if (dryRun) return;

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  let written = 0;
  let unchanged = 0;
  for (const item of plan) {
    const target = path.join(TARGET_DIR, `${item.id}.svg`);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === item.svg) {
      unchanged += 1;
      continue;
    }
    fs.writeFileSync(target, item.svg);
    written += 1;
  }
  console.log(`· 写入 ${written} 个, 内容未变 ${unchanged} 个`);

  // 清掉源目录已删除的残留文件。
  const orphans = fs.readdirSync(TARGET_DIR)
    .filter((file) => file.endsWith('.svg') && !files.includes(file));
  for (const file of orphans) fs.rmSync(path.join(TARGET_DIR, file));
  if (orphans.length > 0) console.log(`· 清理源里已不存在的 ${orphans.length} 个`);
}

function avg(sorted) {
  return (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(3);
}

function percentile(sorted, p) {
  return sorted[Math.floor(sorted.length * p)].toFixed(3);
}

main();
