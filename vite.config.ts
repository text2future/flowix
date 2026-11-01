import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dirname, "app/flowix-web");

// KaTeX ships every font in three formats (woff2 / woff / ttf) so it can serve
// ancient browsers, but Flowix only targets modern Chromium via Tauri. Strip
// the woff and ttf fallback entries from `katex.min.css` so the bundler emits
// the woff2 variant only. Each font family goes from ~3 emitted assets down to
// one (~250 KB total instead of ~1 MB).
function modernFontWoff2Only(): Plugin {
  return {
    name: "flowix-modern-font-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (
        !id.includes("node_modules/katex/dist/katex.min.css")
        && !id.includes("node_modules/@fontsource/inter/")
      ) {
        return null;
      }
      const transformed = code
        .replace(
          /,\s*url\([^)]+\.woff\) format\(["']woff["']\)/g,
          "",
        )
        .replace(
          /,url\([^)]+\.ttf\) format\(["']truetype["']\)/g,
          "",
        );
      if (transformed === code) {
        return null;
      }
      return { code: transformed, map: null };
    },
  };
}

// Vite adds `crossorigin` to module scripts, modulepreload links and styles in
// production HTML. These resources are same-origin in a normal HTTP build,
// but a packaged Tauri app serves them through its asset protocol. WKWebView
// can complete the asset request while refusing to execute the module under
// the CORS fetch mode. Relative URLs already preserve same-origin behavior,
// so the attribute is unnecessary and breaks the packaged entrypoint.
function removePackagedCrossorigin(): Plugin {
  return {
    name: "flowix-remove-packaged-crossorigin",
    enforce: "post",
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(?:="")?/g, "");
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  return {
    // Packaged Tauri pages are served from an application protocol rather
    // than an HTTP origin. Keep every emitted asset URL relative in builds so
    // CSS, fonts, and lazy chunks resolve beside index.html in the installed
    // app. The dev server still needs an origin-root base for HMR.
    base: command === "build" ? "./" : "/",
    // 鍓嶇鍏ュ彛: app/flowix-web/ 浣滀负 Vite 鏍? 璁?index.html / entrypoints /
    // public 閮藉湪鍚屼竴鐩綍, 閬垮厤 Tauri / Vite 璺緞浜掔浉绌胯秺銆?
    root: frontendRoot,
    publicDir: resolve(frontendRoot, "public"),
    // Module workers need ES output so lazy Shiki grammars and WASM can stay
    // in separate chunks instead of forcing every language into one bundle.
    worker: {
      format: "es",
    },
    build: {
      outDir: resolve(__dirname, ".build/web-dist"),
      emptyOutDir: true,
      // 属性图标 (assets/property-icons/<包>/<分类>/*.svg) 有上千张, 默认
      // assetsInlineLimit (4KB) 会把它们全部内联成 data URI 塞进 JS chunk
      // (164 张时就已经占 260KB)。这里对这批文件关掉内联, 让它们作为独立
      // 资源产出 —— picker 只渲染当前分类, 未展示的图标根本不会被请求。
      assetsInlineLimit: (filePath) => (
        filePath.includes("/assets/property-icons/") ? false : undefined
      ),
      // The bundle budget follows the desktop startup graph through this
      // manifest instead of looking only at index.html.
      manifest: true,
      rollupOptions: {
        input: resolve(frontendRoot, "index.html"),
        output: {
          // Keep dependencies of dynamic imports in their dynamic graph.
          // Without this, Rollup may absorb shared dependencies into an
          // explicit vendor chunk and turn optional Mermaid into an entry
          // modulepreload.
          onlyExplicitManualChunks: true,
          manualChunks(id) {
            // Language grammars use literal dynamic imports and intentionally
            // remain separate chunks. Grouping @shikijs/langs here would turn
            // one requested grammar back into the entire curated language set.
            //
            // Do not split @shikijs/themes into a manual chunk: the editor's
            // static startup graph imports the theme definitions, and Rollup
            // then emits a modulepreload for that supposedly optional chunk.
            // On packaged WKWebView/asset:// loads, a failed preload can block
            // the root entry before React removes the static app spinner.
            if (id.includes("node_modules/shiki/") || id.includes("node_modules/@shiki/")) {
              return "shiki-core";
            }
            // 重型 vendor: 每个 400-700KB, 单独命名避免被 Rollup 兜底合并。
            // mermaid 主包本身 (~600KB) + 各 diagram 子包 (c4/flow/gantt/...
            // 各 ~50KB) 合在一起会被 Rollup heuristic 拖成 2.5MB 兜底块。
            // 这里锁住 mermaid 主包, 让子包按各自依赖图独立。
            if (
              id.includes("node_modules/mermaid/dist/mermaid") ||
              id.includes("node_modules/mermaid/dist/mermaid.esm") ||
              id.includes("node_modules/mermaid/src/")
            ) {
              return "vendor-mermaid";
            }
            if (id.includes("node_modules/katex")) {
              return "vendor-katex";
            }
          },
        },
      },
    },

    plugins: [react(), modernFontWoff2Only(), removePackagedCrossorigin()],
    resolve: {
      alias: {
        "@": frontendRoot,
        "@app": resolve(frontendRoot, "app"),
        "@features": resolve(frontendRoot, "features"),
        "@platform": resolve(frontendRoot, "platform"),
        "@shared": resolve(frontendRoot, "shared"),
        "@flowix-target-entry": resolve(frontendRoot, "entrypoints/desktop.tsx"),
      },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
          protocol: "ws",
          host,
          port: 1421,
        }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `backend` (relative to repo root)
        ignored: ["**/app/flowix-desktop/**", "**/app/flowix-core/**", "**/app/flowix-cli/**", "**/app/target/**"],
      },
    },
  };
});
