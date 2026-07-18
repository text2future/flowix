#!/usr/bin/env node
// Extracts Phosphor SVG path strings (configurable weight) from
// @phosphor-icons/react's defs/<PascalName>.es.js files, then prints
// them out as a TS object literal body in the exact shape used by
// `app/flowix-web/features/agent/message/tools.tsx::TOOL_ICON_PATHS`.
//
// Why this script exists: `tools.tsx` stores tool icons as inline SVG
// path strings (256×256 viewBox) so both the React panel and the
// Tiptap-NodeView agent-thread-card can render them without pulling
// in a React component. Manually copying paths from the Phosphor
// source is error-prone; this script automates it.
//
// ── Usage ──
//     node scripts/extract-phosphor-bold-paths.mjs                       # bold (default)
//     node scripts/extract-phosphor-bold-paths.mjs --weight regular      # regular
//     node scripts/extract-phosphor-bold-paths.mjs --weight fill          # fill
//     node scripts/extract-phosphor-bold-paths.mjs --keys-only           # just registry keys
//     node scripts/extract-phosphor-bold-paths.mjs --validate           # exit 1 if any icon missing
//
// Available weights (in Phosphor's defs Map insertion order):
//     bold → duotone → fill → light → regular → thin
//
// To add a new tool icon:
//   1. Find the Phosphor PascalCase name (e.g. "MagnifyingGlass")
//   2. Add a row to ICONS below: [PascalName]: <registryKey>
//   3. Re-run this script and paste the output line into TOOL_ICON_PATHS
//
// ── Why weight-keyed regex works ──
// @phosphor-icons/react ships each icon as `defs/<Name>.es.js` whose
// default export is a Map<weight, ReactElement>. We target the
// `["<weight>",` key, then capture the next `d: "..."` literal.
// Verified across all 15 icons currently used by `tools.tsx`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const defsDir = path.join(
	root,
	'node_modules/@phosphor-icons/react/dist/defs',
);

// PascalCase Phosphor name → registry key (matches TOOL_ICON_PATHS
// in tools.tsx). To add a new tool icon, append a row here AND add
// the corresponding key to TOOL_ICON_PATHS in tools.tsx.
const ICONS = {
	Folder: 'folder',
	FileText: 'fileText',
	FilePlus: 'filePlus',
	Trash: 'trash',
	MagnifyingGlass: 'magnify',
	Terminal: 'terminal',
	Code: 'code',
	GitBranch: 'gitBranch',
	Database: 'database',
	Globe: 'globe',
	Gear: 'gear',
	Play: 'play',
	Pause: 'pause',
	ArrowsClockwise: 'arrowsClockwise',
	Eye: 'eye',
	Plug: 'plug',
	FileCode: 'fileCode',
	Image: 'image',
	Wrench: 'wrench',
	UsersThree: 'usersThree',
	MagnifyingGlassPlus: 'magnifyPlus',
};

const args = new Set(process.argv.slice(2));
// Find --weight <name> or --weight=<name>. Default: bold.
let WEIGHT = 'bold';
for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === '--weight' && i + 1 < process.argv.length) {
		WEIGHT = process.argv[i + 1];
	} else if (arg.startsWith('--weight=')) {
		WEIGHT = arg.split('=')[1];
	}
}

// Target `["<weight>",` then capture the next `d: "..."`.
const WEIGHT_RE = new RegExp(`\\[\\s*"${WEIGHT}"\\s*,[\\s\\S]*?d:\\s*"([^"]+)"`);

const keysOnly = args.has('--keys-only');
const validate = args.has('--validate');

if (validate) {
	// Validate-only mode: exit non-zero if any icon is missing from
	// node_modules. Useful in CI / pre-commit hooks.
	const missing = [];
	for (const iconName of Object.keys(ICONS)) {
		const file = path.join(defsDir, `${iconName}.es.js`);
		if (!fs.existsSync(file)) missing.push(iconName);
	}
	if (missing.length > 0) {
		console.error(`Missing Phosphor defs for: ${missing.join(', ')}`);
		process.exit(1);
	}
	console.log(`✓ All ${Object.keys(ICONS).length} icons present in ${defsDir}`);
	process.exit(0);
}

const out = {};
for (const [iconName, registryKey] of Object.entries(ICONS)) {
	const file = path.join(defsDir, `${iconName}.es.js`);
	if (!fs.existsSync(file)) {
		console.error(`✗ ${iconName}: defs file not found at ${file}`);
		process.exit(1);
	}
	const content = fs.readFileSync(file, 'utf8');
	const m = content.match(WEIGHT_RE);
	if (!m) {
		console.error(`✗ ${iconName}: no "${WEIGHT}" weight found`);
		process.exit(1);
	}
	out[registryKey] = m[1];
}

if (keysOnly) {
	console.log(Object.keys(out).join('\n'));
} else {
	// Mirror the exact `key: "...",` shape used by tools.tsx::TOOL_ICON_PATHS
	// so the output can be pasted in directly.
	console.log(`// Paste these lines into tools.tsx::TOOL_ICON_PATHS (${WEIGHT} weight):`);
	console.log('');
	for (const [k, v] of Object.entries(out)) {
		console.log(`\t${k}: "${v}",`);
	}
}
