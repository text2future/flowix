// Regenerates the desktop icon set from app/flowix-web/assets/app-icon-source.png.
//
// This script must never rewrite app/flowix-web/assets/product-logo.png.
// product-logo.png is the in-app titlebar logo; app-icon-source.png is the
// packaged desktop App icon source.
//
// Run from repo root:
//
//     node scripts/gen-icon.mjs
//
// macOS keeps the source art's transparent padding, because platform icon
// templates expect optical inset. Windows icons are generated from a trimmed
// temporary PNG so the icon fills the square without the macOS outer padding.
//
// For the Mac DMG "drag to /Applications" window (the user-facing area next
// to the Applications alias) we also bake in MAC_PADDING_PERCENT of extra
// transparent margin on each side, on top of whatever padding the source
// already has. This shrinks the optical art inside the icon canvas so it
// doesn't visually crowd the macOS rounded-square mask. Windows generation
// uses the same trim flow and is unaffected — the trim happens against the
// content bbox, so adding outer transparency does not change Windows output.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const backendDir = resolve(root, 'app/flowix-desktop');
const productLogoPng = resolve(root, 'app/flowix-web/assets/product-logo.png');
const sourcePng = resolve(root, 'app/flowix-web/assets/app-icon-source.png');
const iconsDir = resolve(backendDir, 'icons');
const tmpDir = resolve(root, '.tmp-icon-build');
const macIconsDir = resolve(tmpDir, 'mac');
const macPngDir = resolve(tmpDir, 'mac-png');
const winIconsDir = resolve(tmpDir, 'windows');
const windowsSourcePng = resolve(tmpDir, 'app-icon-source.windows.png');
const macPaddedSourcePng = resolve(tmpDir, 'app-icon-source.mac.png');

// Extra transparent margin baked around the Mac icon source, on top of the
// padding the source PNG already carries. 12% per side → content occupies
// ~76% of the canvas, matching Apple's macOS 11+ icon optical inset guidance.
// Windows trimming ignores this padding, so it is Mac-only by construction.
const MAC_PADDING_PERCENT = 12;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WINDOWS_ICON_FILES = [
	'icon.ico',
	'icon.png',
	'StoreLogo.png',
	'Square30x30Logo.png',
	'Square44x44Logo.png',
	'Square71x71Logo.png',
	'Square89x89Logo.png',
	'Square107x107Logo.png',
	'Square142x142Logo.png',
	'Square150x150Logo.png',
	'Square284x284Logo.png',
	'Square310x310Logo.png',
];

console.log(`source  ${sourcePng}`);
console.log(`output  ${iconsDir}`);

const productLogoHashBefore = fileHash(productLogoPng);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const trimInfo = trimTransparentPngToSquare(sourcePng, windowsSourcePng);
console.log(
	`windows trim ${trimInfo.sourceWidth}x${trimInfo.sourceHeight} -> ${trimInfo.size}x${trimInfo.size} ` +
		`from bbox ${trimInfo.contentWidth}x${trimInfo.contentHeight}+${trimInfo.minX}+${trimInfo.minY}`,
);

const padInfo = padPngCanvas(sourcePng, macPaddedSourcePng, MAC_PADDING_PERCENT);
console.log(
	`mac pad +${MAC_PADDING_PERCENT}% per side: ${padInfo.sourceWidth}x${padInfo.sourceHeight} ` +
		`-> ${padInfo.canvasWidth}x${padInfo.canvasHeight}, content ${padInfo.contentWidth}x${padInfo.contentHeight} ` +
		`(${padInfo.contentFillPercent.toFixed(1)}% fill)`,
);

runTauriIcon(macPaddedSourcePng, macIconsDir);
runTauriPngSet(macPaddedSourcePng, macPngDir);
runTauriIcon(windowsSourcePng, winIconsDir);

rmSync(iconsDir, { recursive: true, force: true });
cpSync(macIconsDir, iconsDir, { recursive: true });
createMacIconset(macPngDir, resolve(iconsDir, 'icon.iconset'));

for (const file of WINDOWS_ICON_FILES) {
	const from = resolve(winIconsDir, file);
	if (existsSync(from)) {
		cpSync(from, resolve(iconsDir, basename(file)));
	}
}

// Drop mobile assets the CLI just produced; this project is desktop only.
for (const sub of ['android', 'ios']) {
	rmSync(resolve(iconsDir, sub), { recursive: true, force: true });
}
console.log('cleaned app/flowix-desktop/icons/{android,ios}');

rmSync(tmpDir, { recursive: true, force: true });
const productLogoHashAfter = fileHash(productLogoPng);
if (productLogoHashBefore !== productLogoHashAfter) {
	throw new Error('gen-icon.mjs must not modify app/flowix-web/assets/product-logo.png');
}

function fileHash(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function runTauriIcon(input, output) {
	execSync(`npx tauri icon "${input}" --output "${output}"`, {
		cwd: backendDir,
		stdio: 'inherit',
	});
}

function runTauriPngSet(input, output) {
	execSync(
		`npx tauri icon "${input}" --output "${output}" ` +
			'--png 16 --png 32 --png 64 --png 128 --png 256 --png 512 --png 1024',
		{
			cwd: backendDir,
			stdio: 'inherit',
		},
	);
}

function createMacIconset(pngDir, iconsetDir) {
	mkdirSync(iconsetDir, { recursive: true });
	const iconsetMap = {
		'icon_16x16.png': '16x16.png',
		'icon_16x16@2x.png': '32x32.png',
		'icon_32x32.png': '32x32.png',
		'icon_32x32@2x.png': '64x64.png',
		'icon_128x128.png': '128x128.png',
		'icon_128x128@2x.png': '256x256.png',
		'icon_256x256.png': '256x256.png',
		'icon_256x256@2x.png': '512x512.png',
		'icon_512x512.png': '512x512.png',
		'icon_512x512@2x.png': '1024x1024.png',
	};

	for (const [target, source] of Object.entries(iconsetMap)) {
		cpSync(resolve(pngDir, source), resolve(iconsetDir, target));
	}
}

function trimTransparentPngToSquare(input, output) {
	const png = decodePng(readFileSync(input));
	const bbox = findAlphaBounds(png);
	if (!bbox) {
		throw new Error(`Cannot trim ${input}: no non-transparent pixels found`);
	}

	const contentWidth = bbox.maxX - bbox.minX + 1;
	const contentHeight = bbox.maxY - bbox.minY + 1;
	const size = Math.max(contentWidth, contentHeight);
	const cropX = clamp(Math.round((bbox.minX + bbox.maxX + 1 - size) / 2), 0, png.width - size);
	const cropY = clamp(Math.round((bbox.minY + bbox.maxY + 1 - size) / 2), 0, png.height - size);
	const data = Buffer.alloc(size * size * 4);

	for (let y = 0; y < size; y += 1) {
		const srcStart = ((cropY + y) * png.width + cropX) * 4;
		const dstStart = y * size * 4;
		png.data.copy(data, dstStart, srcStart, srcStart + size * 4);
	}

	writeFileSync(output, encodePng({ width: size, height: size, data }));

	return {
		sourceWidth: png.width,
		sourceHeight: png.height,
		minX: bbox.minX,
		minY: bbox.minY,
		contentWidth,
		contentHeight,
		size,
	};
}

// Wrap `input` in a larger transparent canvas so the visible art shrinks to
// `(1 - 2*padPercent/100)` of the canvas on each axis, centered. Used to bake
// extra optical inset into the Mac icon source before `tauri icon` runs.
function padPngCanvas(input, output, padPercent) {
	const png = decodePng(readFileSync(input));
	const bbox = findAlphaBounds(png);
	if (!bbox) {
		throw new Error(`Cannot pad ${input}: no non-transparent pixels found`);
	}
	if (padPercent < 0) {
		throw new Error(`padPercent must be non-negative, got ${padPercent}`);
	}

	const contentWidth = bbox.maxX - bbox.minX + 1;
	const contentHeight = bbox.maxY - bbox.minY + 1;
	const side = Math.max(contentWidth, contentHeight);
	const scale = 1 - (2 * padPercent) / 100;
	if (scale <= 0) {
		throw new Error(`padPercent ${padPercent} would erase the content`);
	}
	const newSide = Math.ceil(side / scale);
	const canvasWidth = newSide;
	const canvasHeight = newSide;
	const offsetX = Math.round((canvasWidth - side) / 2);
	const offsetY = Math.round((canvasHeight - side) / 2);
	const data = Buffer.alloc(canvasWidth * canvasHeight * 4);

	for (let y = 0; y < side; y += 1) {
		const srcStart = ((bbox.minY + y) * png.width + bbox.minX) * 4;
		const dstStart = ((offsetY + y) * canvasWidth + offsetX) * 4;
		png.data.copy(data, dstStart, srcStart, srcStart + side * 4);
	}

	writeFileSync(output, encodePng({ width: canvasWidth, height: canvasHeight, data }));

	return {
		sourceWidth: png.width,
		sourceHeight: png.height,
		contentWidth,
		contentHeight,
		canvasWidth,
		canvasHeight,
		offsetX,
		offsetY,
		contentFillPercent: (side / canvasWidth) * 100,
	};
}

function decodePng(buffer) {
	if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		throw new Error('Expected PNG input');
	}

	let offset = PNG_SIGNATURE.length;
	let width = 0;
	let height = 0;
	let colorType = -1;
	let bitDepth = -1;
	const idat = [];

	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString('ascii', offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		offset += 12 + length;

		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
		} else if (type === 'IDAT') {
			idat.push(data);
		} else if (type === 'IEND') {
			break;
		}
	}

	if (bitDepth !== 8 || colorType !== 6) {
		throw new Error(`Expected 8-bit RGBA PNG, got bitDepth=${bitDepth} colorType=${colorType}`);
	}

	const bytesPerPixel = 4;
	const stride = width * bytesPerPixel;
	const inflated = inflateSync(Buffer.concat(idat));
	const data = Buffer.alloc(width * height * bytesPerPixel);
	let src = 0;

	for (let y = 0; y < height; y += 1) {
		const filter = inflated[src];
		src += 1;
		const row = inflated.subarray(src, src + stride);
		const outStart = y * stride;
		const prevStart = y === 0 ? -1 : (y - 1) * stride;

		for (let x = 0; x < stride; x += 1) {
			const left = x >= bytesPerPixel ? data[outStart + x - bytesPerPixel] : 0;
			const up = prevStart >= 0 ? data[prevStart + x] : 0;
			const upLeft = prevStart >= 0 && x >= bytesPerPixel ? data[prevStart + x - bytesPerPixel] : 0;
			const value = row[x];
			data[outStart + x] = unfilterByte(filter, value, left, up, upLeft);
		}
		src += stride;
	}

	return { width, height, data };
}

function encodePng({ width, height, data }) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const rawStart = y * (stride + 1);
		raw[rawStart] = 0;
		data.copy(raw, rawStart + 1, y * stride, (y + 1) * stride);
	}

	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk('IHDR', createIhdr(width, height)),
		pngChunk('IDAT', deflateSync(raw, { level: 9 })),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}

function createIhdr(width, height) {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	data[8] = 8;
	data[9] = 6;
	data[10] = 0;
	data[11] = 0;
	data[12] = 0;
	return data;
}

function pngChunk(type, data) {
	const typeBuffer = Buffer.from(type, 'ascii');
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBuffer.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
	return chunk;
}

function findAlphaBounds({ width, height, data }) {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (data[(y * width + x) * 4 + 3] === 0) continue;
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}
	return maxX === -1 ? null : { minX, minY, maxX, maxY };
}

function unfilterByte(filter, value, left, up, upLeft) {
	switch (filter) {
		case 0:
			return value;
		case 1:
			return (value + left) & 0xff;
		case 2:
			return (value + up) & 0xff;
		case 3:
			return (value + Math.floor((left + up) / 2)) & 0xff;
		case 4:
			return (value + paeth(left, up, upLeft)) & 0xff;
		default:
			throw new Error(`Unsupported PNG filter: ${filter}`);
	}
}

function paeth(left, up, upLeft) {
	const p = left + up - upLeft;
	const pa = Math.abs(p - left);
	const pb = Math.abs(p - up);
	const pc = Math.abs(p - upLeft);
	if (pa <= pb && pa <= pc) return left;
	if (pb <= pc) return up;
	return upLeft;
}

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}
