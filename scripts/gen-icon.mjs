// Regenerates the desktop icon set from app/flowix-web/assets/product-logo.png.
//
// Run from repo root:
//
//     node scripts/gen-icon.mjs
//
// Shells out to `npx tauri icon` (output defaults to
// `app/flowix-desktop/icons/` next to tauri.conf.json). The CLI also writes
// iOS / Android / Windows Store variants by default; this project
// ships desktop only, so the script drops the mobile dirs afterwards.
//
// One-off script — safe to delete after running.

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const backendDir = resolve(root, 'app/flowix-desktop');
const sourcePng = resolve(root, 'app/flowix-web/assets/product-logo.png');
const iconsDir = resolve(backendDir, 'icons');

console.log(`source  ${sourcePng}`);
console.log(`output  ${iconsDir}`);

execSync(`npx tauri icon "${sourcePng}"`, {
	cwd: backendDir,
	stdio: 'inherit',
});

// Drop mobile assets the CLI just produced — project is desktop only.
for (const sub of ['android', 'ios']) {
	rmSync(resolve(iconsDir, sub), { recursive: true, force: true });
}
console.log('cleaned app/flowix-desktop/icons/{android,ios}');
