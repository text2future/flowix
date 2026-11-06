// Generates `app/flowix-desktop/icons/md.ico` — the icon Windows Explorer,
// the desktop and the taskbar show for `.md` files when Flowix is the handler.
//
// Why this exists: the NSIS template that Tauri generates registers the class
// with `DefaultIcon = "$INSTDIR\Flowix.exe,0"` (see tauri-bundler
// src/bundle/windows/nsis/installer.nsi:642), so every association inherits the
// application icon. Shipping a dedicated .ico and rewriting that one registry
// value from our installer hook (app/flowix-desktop/nsis/flowix-cli-path.nsh)
// is the only way to give `.md` its own artwork.
//
// The drawing lives in scripts/lib/md-file-icon.mjs, shared with
// scripts/gen-md-icns.mjs so both platforms ship the same document icon.
//
// Run from repo root:
//
//     node scripts/gen-md-ico.mjs                    # Flowix warm palette
//     node scripts/gen-md-ico.mjs --theme markdown   # original teal markdown
//     node scripts/gen-md-ico.mjs --no-edge          # drop the outline
//
// Portable: no platform tooling needed, the container is assembled here.

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { THEMES, buildSvg } from './lib/md-file-icon.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const defaultOut = resolve(root, 'app/flowix-desktop/icons/md.ico');

// Sizes Windows actually asks for: 16 (details list), 20/24 (125% / 150% DPI),
// 32 (small icons), 40/48 (medium), 64, 128 and 256 (extra large + tiles).
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
// 256 and 128 ship as PNG (Vista+ reads them natively); everything smaller is
// an uncompressed DIB, which every shell version and third-party tool accepts.
const PNG_FROM = 128;
// Explorer renders file icons on both white and near-black backgrounds, and the
// warm paper is low contrast on white, so the .ico gets a hairline edge. Icons
// are hinted per size the way icon sets usually are: small entries need a
// stronger edge (30/1024 is still under half a pixel at 16px) while 128px and
// up only want a light rim, otherwise it reads as a drawn border.
const edgeWidthFor = (size) => (size <= 48 ? 30 : size <= 96 ? 18 : 10);

const args = process.argv.slice(2);
const themeName = readFlag(args, '--theme') ?? 'flowix';
const outPath = resolve(root, readFlag(args, '--out') ?? defaultOut);
const useEdge = !args.includes('--no-edge');

if (!THEMES[themeName]) {
	throw new Error(`Unknown --theme "${themeName}". Expected one of: ${Object.keys(THEMES).join(', ')}`);
}

const theme = THEMES[themeName];

const images = SIZES.map((size) => {
	const svg = buildSvg(theme, useEdge ? { stroke: theme.edge, width: edgeWidthFor(size) } : null);
	const image = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
	const data = size >= PNG_FROM
		? image.asPng()
		: encodeDib(image.pixels, image.width, image.height);
	return { size, data };
});

const ico = encodeIco(images);
verifyIco(ico, SIZES);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, ico);

const bytes = statSync(outPath).size;
if (bytes < 1024) {
	throw new Error(`Refusing to write a suspiciously small ico (${bytes} bytes)`);
}

console.log(
	`md.ico  theme=${themeName}  edge=${useEdge ? 'on' : 'off'}  sizes=${SIZES.join('/')}  ${bytes} bytes  ->  ${outPath}`,
);

/** Read the container back so a broken encoder fails the build, not Explorer. */
function verifyIco(buffer, expectedSizes) {
	if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
		throw new Error('ICO header is not an icon directory');
	}
	const count = buffer.readUInt16LE(4);
	if (count !== expectedSizes.length) {
		throw new Error(`ICO has ${count} entries, expected ${expectedSizes.length}`);
	}
	for (let index = 0; index < count; index += 1) {
		const at = 6 + index * 16;
		const width = buffer.readUInt8(at) || 256;
		const height = buffer.readUInt8(at + 1) || 256;
		const bytesInRes = buffer.readUInt32LE(at + 8);
		const offset = buffer.readUInt32LE(at + 12);
		if (width !== expectedSizes[index] || height !== width) {
			throw new Error(`ICO entry ${index} is ${width}x${height}, expected ${expectedSizes[index]}`);
		}
		if (offset + bytesInRes > buffer.length) {
			throw new Error(`ICO entry ${index} points past the end of the container`);
		}
		const blob = buffer.subarray(offset, offset + bytesInRes);
		const isPng = blob.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
		if (!isPng) {
			// DIB entries stack the XOR bitmap and the AND mask, so biHeight is 2h.
			if (blob.readUInt32LE(0) !== 40 || blob.readInt32LE(8) !== width * 2) {
				throw new Error(`ICO entry ${index} (${width}px) is a malformed DIB`);
			}
		}
	}
}

/**
 * Assemble an ICONDIR: 6-byte header, one 16-byte entry per image, then blobs.
 * A 256px entry encodes its width/height as 0, the format's way of saying 256.
 */
function encodeIco(entries) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(entries.length, 4);

	const dir = Buffer.alloc(entries.length * 16);
	let offset = 6 + entries.length * 16;
	entries.forEach((entry, index) => {
		const at = index * 16;
		const dim = entry.size >= 256 ? 0 : entry.size;
		dir.writeUInt8(dim, at);
		dir.writeUInt8(dim, at + 1);
		dir.writeUInt8(0, at + 2); // palette size
		dir.writeUInt8(0, at + 3); // reserved
		dir.writeUInt16LE(1, at + 4); // planes
		dir.writeUInt16LE(32, at + 6); // bits per pixel
		dir.writeUInt32LE(entry.data.length, at + 8);
		dir.writeUInt32LE(offset, at + 12);
		offset += entry.data.length;
	});

	return Buffer.concat([header, dir, ...entries.map((entry) => entry.data)]);
}

/**
 * Encode RGBA pixels as a 32bpp BMP entry: BITMAPINFOHEADER (bottom-up BGRA)
 * followed by the 1bpp AND mask legacy shells use for transparency.
 *
 * resvg hands back premultiplied RGBA, while the BMP expects straight alpha —
 * without the division antialiased edges keep the darkened colour they had when
 * composited against nothing, which shows up as a grey fringe at 16px.
 */
function encodeDib(pixels, width, height) {
	const xor = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		const sourceRow = (height - 1 - y) * width * 4;
		for (let x = 0; x < width; x += 1) {
			const source = sourceRow + x * 4;
			const target = (y * width + x) * 4;
			const alpha = pixels[source + 3];
			const scale = alpha === 0 ? 0 : 255 / alpha;
			xor[target] = Math.min(255, Math.round(pixels[source + 2] * scale));
			xor[target + 1] = Math.min(255, Math.round(pixels[source + 1] * scale));
			xor[target + 2] = Math.min(255, Math.round(pixels[source] * scale));
			xor[target + 3] = alpha;
		}
	}

	const maskStride = Math.ceil(width / 32) * 4;
	const mask = Buffer.alloc(maskStride * height);
	for (let y = 0; y < height; y += 1) {
		const sourceRow = (height - 1 - y) * width * 4;
		for (let x = 0; x < width; x += 1) {
			if (pixels[sourceRow + x * 4 + 3] === 0) {
				mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
			}
		}
	}

	const info = Buffer.alloc(40);
	info.writeUInt32LE(40, 0); // biSize
	info.writeInt32LE(width, 4);
	info.writeInt32LE(height * 2, 8); // XOR + AND stacked
	info.writeUInt16LE(1, 12); // biPlanes
	info.writeUInt16LE(32, 14); // biBitCount
	info.writeUInt32LE(0, 16); // BI_RGB
	info.writeUInt32LE(xor.length + mask.length, 20); // biSizeImage

	return Buffer.concat([info, xor, mask]);
}

function readFlag(argv, name) {
	const inline = argv.find((arg) => arg.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}
