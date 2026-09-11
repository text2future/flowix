#!/usr/bin/env node
// scripts/check-layer-boundaries.mjs
//
// 强制前端层级边界 (platform < lib/shared < features < app):
//   - shared / lib / platform 不得 import @features/* 或 @app/*
//     (低层不反向依赖高层; @/types 中性层任意方可用)
//   - features / shared / lib 不得直接 import @tauri-apps/*
//     (必须走 @platform/tauri/* 封装; platform 是 Tauri 适配层故豁免;
//      app 是组合根故豁免; 测试文件豁免 ── vi.mock 底层模块是合法用法)
//
// 设计: 与 CI "先保证绿灯, 再逐步收紧" 哲学一致。无新依赖, 纯静态扫描。
// 防"9 处反向依赖"类问题回退 ── 见 Flowix 技术债务清单 P0 前端结构。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../app/flowix-web', import.meta.url));

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.build') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(p);
  }
  return acc;
}

const files = walk(ROOT);
const violations = [];

// 静态 import/export ... from '...' (含多行)
const FROM_RE = /\b(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
// 动态 import('...')
const DYN_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const rel = (p) => relative(ROOT, p).replaceAll('\\', '/');
const isTest = (p) => /\.(test|spec)\.(ts|tsx)$/.test(p);
const isLowLayer = (layer) => layer === 'shared' || layer === 'lib' || layer === 'platform';
const isMidLayer = (layer) => layer === 'features' || layer === 'shared' || layer === 'lib';

for (const file of files) {
  const r = rel(file);
  const src = readFileSync(file, 'utf8');
  const layer = r.split('/')[0];
  const specs = [];
  for (const re of [FROM_RE, DYN_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) specs.push(m[1]);
  }

  for (const spec of specs) {
    // Rule A: 低层不得反向依赖 features / app
    if (isLowLayer(layer) && (spec.startsWith('@features/') || spec.startsWith('@app/'))) {
      violations.push(`${r}: 反向依赖 ${spec}  (低层 ${layer} 不得 import features/app)`);
    }
    // Rule B: features/shared/lib 不得直接 import @tauri-apps/* (非测试)
    if (!isTest(file) && isMidLayer(layer) && spec.startsWith('@tauri-apps/')) {
      violations.push(`${r}: 直接 import ${spec}  (须走 @platform/tauri/* 封装)`);
    }
    // Rule C: migrated cross-feature seams use the owning module's public
    // entrypoint. Add files here only after their deep imports are removed;
    // this keeps the migration incremental without grandfathering new debt.
    if (
      !isTest(file)
      && r.startsWith('features/workspace/')
      && /^@features\/(agent|document|editor|memo|plugin|preferences|shell|surface)\//.test(spec)
      && !/^@features\/(agent|document|editor|memo|plugin|preferences|shell|surface)\/public\//.test(spec)
    ) {
      violations.push(`${r}: 跨模块依赖必须走公开入口，禁止 import ${spec}`);
    }
    if (
      !isTest(file)
      && r.startsWith('app/main-window/')
      && /^@features\/[a-z0-9-]+\//.test(spec)
      && !/^@features\/[a-z0-9-]+\/public\//.test(spec)
    ) {
      violations.push(`${r}: Main Window 组合必须走模块公开入口，禁止 import ${spec}`);
    }
    if (
      !isTest(file)
      && r === 'app/app.tsx'
      && /^@features\/(agent|preferences)\//.test(spec)
      && !/^@features\/(agent|preferences)\/public\//.test(spec)
    ) {
      violations.push(`${r}: App 组合必须走公开入口，禁止 import ${spec}`);
    }
    if (
      !isTest(file)
      && ['app/main-window-effects.tsx', 'app/main-window-startup.ts'].includes(r)
      && /^@features\/(agent|document|memo|workspace)\//.test(spec)
      && !/^@features\/(agent|document|memo|workspace)\/public\//.test(spec)
    ) {
      violations.push(`${r}: Main Window effects 必须走公开入口，禁止 import ${spec}`);
    }
    if (
      !isTest(file)
      && (
        r.startsWith('features/shell/components/prompts/')
        || r === 'features/shell/components/main-status-bar-host.tsx'
        || r === 'features/shell/components/main-prompt-host.tsx'
        || r === 'features/shell/hooks/use-main-middle-column-controller.tsx'
        || r === 'features/shell/hooks/use-main-panel-controller.ts'
        || r === 'features/shell/hooks/browser-column-layout.ts'
        || r === 'features/shell/components/browser-column.tsx'
        || r === 'features/shell/components/browser-column-header.tsx'
        || r === 'features/shell/components/work-column-titlebar-shell.tsx'
        || r === 'features/shell/components/drag-overlay/markdown-file-drop-overlay.tsx'
        || r === 'features/shell/components/global-search-command.tsx'
      )
      && /^@features\/(agent|document|memo|plugin|preferences|surface|workspace)\//.test(spec)
      && !/^@features\/(agent|document|memo|plugin|preferences|surface|workspace)\/public\//.test(spec)
    ) {
      violations.push(`${r}: Shell 展示协调层跨模块依赖必须走公开入口，禁止 import ${spec}`);
    }
    if (
      !isTest(file)
      && r === 'features/preferences/components/dsh-install-prompt.tsx'
      && /^@features\/agent\//.test(spec)
      && !spec.startsWith('@features/agent/public/')
    ) {
      violations.push(`${r}: DSH onboarding 必须走 Agent 公开入口，禁止 import ${spec}`);
    }
    if (
      !isTest(file)
      && /^(features\/(agent|document|editor|memo|shortcuts|theme)\/)/.test(r)
      && /^@features\/preferences\//.test(spec)
      && !spec.startsWith('@features/preferences/public/')
    ) {
      violations.push(`${r}: Preferences 配置必须走公开运行时接口，禁止 import ${spec}`);
    }
    if (
      !isTest(file)
      && r === 'features/shell/main-layout.tsx'
      && /^@features\/(agent|document|memo|plugin|preferences|surface|workspace)\//.test(spec)
      && !/^@features\/(agent|document|memo|plugin|preferences|surface|workspace)\/public\//.test(spec)
    ) {
      violations.push(`${r}: MainLayout 跨模块依赖必须走 Shell 专用公开入口，禁止 import ${spec}`);
    }
    // Rule D: foundational Agent session services receive Store capabilities
    // through ports. Importing the Zustand singleton here recreates a static
    // cycle with the composition root.
    if (
      !isTest(file)
      && [
        'features/agent/store/stream-event-dispatcher.ts',
        'features/agent/store/external-event-replay.ts',
        'features/agent/store/session-meta-slice.ts',
        'features/agent/store/projection-slice.ts',
        'features/agent/store/conversation-slice.ts',
        'features/agent/store/thread-history-slice.ts',
        'features/agent/store/thread-lifecycle-slice.ts',
      ].includes(r)
      && spec.includes('agent-session-store')
    ) {
      violations.push(`${r}: Agent session 基础服务不得反向 import agent-session-store`);
    }
  }
}

// AgentSessionStore is a composition root, not a place to accumulate slice
// implementations again. Keep the limit slightly above the documented target
// so formatting-only edits do not create noisy failures.
const agentSessionStoreFile = files.find(
  (file) => rel(file) === 'features/agent/store/agent-session-store.ts',
);
if (agentSessionStoreFile) {
  const source = readFileSync(agentSessionStoreFile, 'utf8');
  const lineCount = source.split(/\r?\n/).length;
  if (lineCount > 650) {
    violations.push(
      `features/agent/store/agent-session-store.ts: ${lineCount} 行 > 650  (组合根不得重新膨胀)`,
    );
  }
  const partializeBody = source.match(/partialize:\s*\(state\)[\s\S]*?\n\s*merge:/)?.[0] ?? '';
  if (/threadProjections|conversationRegistry/.test(partializeBody)) {
    violations.push(
      'features/agent/store/agent-session-store.ts: partialize 不得持久化消息投影或 conversation registry',
    );
  }
}

const agentSessionStoreCreations = files.reduce((count, file) => {
  if (isTest(file)) return count;
  return count + (readFileSync(file, 'utf8').match(/create<AgentSessionStore>/g)?.length ?? 0);
}, 0);
if (agentSessionStoreCreations !== 1) {
  violations.push(
    `AgentSessionStore create 数量必须为 1，当前为 ${agentSessionStoreCreations}`,
  );
}

for (const file of files) {
  const r = rel(file);
  if (!r.endsWith('/public/app-api.ts')) continue;
  const source = readFileSync(file, 'utf8');
  if (/export\s*\{[^}]*\buse[A-Za-z0-9]*Store\b[^}]*\}/s.test(source)) {
    violations.push(`${r}: App 公共 API 不得导出完整 Store`);
  }
}

if (violations.length) {
  console.error(`\n❌ 层级边界违规 (${violations.length}):`);
  for (const v of violations) console.error('  ' + v);
  console.error('\n规则: platform/lib/shared 不反向依赖 features/app; features/lib/shared 不直引 @tauri-apps/*。');
  console.error('例外: platform 与 app 豁免 @tauri-apps; 测试文件豁免 @tauri-apps (vi.mock)。\n');
  process.exit(1);
}
console.log(`✓ 层级边界检查通过 (扫描 ${files.length} 文件)`);
