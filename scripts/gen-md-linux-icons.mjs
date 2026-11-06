// Generates the freedesktop icon-theme PNG set for Flowix's `.md` document
// icon: `app/flowix-desktop/icons/md-linux/<size>.png`.
//
// Why this exists (and why it looks nothing like the macOS / Windows paths):
// on Linux a file manager never asks the handler application for a file icon.
// Nautilus / Dolphin / Thunar resolve a file's icon from its MIME type name —
// `text/markdown` -> icon `text-markdown` — looked up in the active icon theme
// and finally in the `hicolor` fallback theme. So the only app-controlled lever
// is to ship a `text-markdown` icon that lands in hicolor before the generic
// sheet does. `app/flowix-desktop/src/app/mime_icon.rs` copies these PNGs into
// `~/.local/share/icons/hicolor/<size>x<size>/mimetypes/` at startup.
//
// Sizes are the ones GTK / KDE actually probe for MIME icons; 16 (list view),
// 24 / 32 (icon view), 48 / 64 (large), 128 / 256 / 512 (retina + previews).
//
// The drawing lives in scripts/lib/md-file-icon.mjs, shared with
// scripts/gen-md-icns.mjs and scripts/gen-md-ico.mjs so the three platforms
// never drift apart.
//
// Run from repo root:
//
//     node scripts/gen-md-linux-icons.mjs                  # Flowix warm palette
//     node scripts/gen-md-linux-icons.mjs --theme markdown # teal markdown
//     node scripts/gen-md-linux-icons.mjs --no-edge        # drop the outline
//
// Portable: pure JS + resvg, no platform tooling needed.

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { THEMES, buildSvg } from './lib/md-file-icon.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const defaultOut = resolve(root, 'app/flowix-desktop/icons/md-linux');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
// Same hinting as the Windows .ico: the warm paper is nearly white against a
// white file-manager background, so small sizes carry a stronger rim (30/1024
// is still under half a pixel at 16px) while 128px and up only want a hairline.
const edgeWidthFor = (size) => (size <= 48 ? 30 : size <= 96 ? 18 : 10);

const args = process.argv.slice(2);
const themeName = readFlag(args, '--theme') ?? 'flowix';
const outDir = resolve(root, readFlag(args, '--out') ?? defaultOut);
const useEdge = !args.includes('--no-edge');

if (!THEMES[themeName]) {
	throw new Error(`Unknown --theme "${themeName}". Expected one of: ${Object.keys(THEMES).join(', ')}`);
}

const theme = THEMES[themeName];
mkdirSync(outDir, { recursive: true });

const written = [];
for (const size of SIZES) {
	const svg = buildSvg(theme, useEdge ? { stroke: theme.edge, width: edgeWidthFor(size) } : null);
	const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
	const file = resolve(outDir, `${size}.png`);
	writeFileSync(file, png);
	verifyPng(file, size);
	written.push(`${size}px`);
}

const total = written.reduce((sum, _, index) => sum + statSync(resolve(outDir, `${SIZES[index]}.png`)).size, 0);
console.log(
	`md-linux  theme=${themeName}  edge=${useEdge ? 'on' : 'off'}  sizes=${written.join('/')}  ${total} bytes  ->  ${outDir}`,
);

/** Read every PNG back: a truncated or mis-sized render must fail the build. */
function verifyPng(file, expected) {
	const buffer = readFileSync(file);
	if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
		throw new Error(`${file} is not a PNG`);
	}
	// IHDR always starts at byte 8: length(4) + type(4) then width/height.
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	if (width !== expected || height !== expected) {
		throw new Error(`${file} is ${width}x${height}, expected ${expected}x${expected}`);
	}
	if (buffer.length < 256) {
		throw new Error(`${file} is suspiciously small (${buffer.length} bytes)`);
	}
}

function readFlag(argv, name) {
	const inline = argv.find((arg) => arg.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}
