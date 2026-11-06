// Generates `app/flowix-desktop/icons/md.icns` — the Finder / Desktop document
// icon macOS shows for `.md` files when Flowix is the default handler.
//
// Why this exists: `bundle.fileAssociations` in tauri.conf.json only declares
// which extensions Flowix opens; the bundler never emits a CFBundleTypeIconFile,
// so Finder falls back to the app icon. The document icon has to be shipped as a
// separate .icns next to the bundle Resources and referenced from the
// CFBundleDocumentTypes entry that app/flowix-desktop/Info.plist overrides.
//
// The drawing itself lives in scripts/lib/md-file-icon.mjs, shared with
// scripts/gen-md-ico.mjs so the Windows icon is the exact same artwork.
//
// Run from repo root:
//
//     node scripts/gen-md-icns.mjs                    # Flowix warm palette
//     node scripts/gen-md-icns.mjs --theme markdown   # original teal markdown
//
// macOS only: relies on `iconutil` to pack the .iconset.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { THEMES, buildSvg } from './lib/md-file-icon.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const defaultOut = resolve(root, 'app/flowix-desktop/icons/md.icns');
const tmpDir = resolve(root, '.tmp-md-icns');

// iconset slot -> rendered pixel size. Several slots share one render.
const ICONSET_SLOTS = [
	['icon_16x16.png', 16],
	['icon_16x16@2x.png', 32],
	['icon_32x32.png', 32],
	['icon_32x32@2x.png', 64],
	['icon_128x128.png', 128],
	['icon_128x128@2x.png', 256],
	['icon_256x256.png', 256],
	['icon_256x256@2x.png', 512],
	['icon_512x512.png', 512],
	['icon_512x512@2x.png', 1024],
];

const args = process.argv.slice(2);
const themeName = readFlag(args, '--theme') ?? 'flowix';
const outPath = resolve(root, readFlag(args, '--out') ?? defaultOut);

if (!THEMES[themeName]) {
	throw new Error(`Unknown --theme "${themeName}". Expected one of: ${Object.keys(THEMES).join(', ')}`);
}
if (process.platform !== 'darwin') {
	throw new Error('gen-md-icns.mjs needs macOS: it packs the iconset with iconutil.');
}

const svg = buildSvg(THEMES[themeName]);
const iconsetDir = resolve(tmpDir, 'md.iconset');

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });

const rendered = new Map();
for (const [slot, size] of ICONSET_SLOTS) {
	let png = rendered.get(size);
	if (!png) {
		png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
		rendered.set(size, png);
	}
	writeFileSync(resolve(iconsetDir, slot), png);
}

mkdirSync(dirname(outPath), { recursive: true });
execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', outPath], { stdio: 'inherit' });

const bytes = statSync(outPath).size;
if (bytes < 1024) {
	throw new Error(`iconutil produced a suspiciously small icns (${bytes} bytes)`);
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(`md.icns  theme=${themeName}  ${bytes} bytes  ->  ${outPath}`);

function readFlag(argv, name) {
	const inline = argv.find((arg) => arg.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}
