import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dirname, 'app/flowix-web');

export default defineConfig({
  resolve: {
    alias: [
      // 属性图标真模块会 eager 收集 1300+ 个 svg; vitest 里逐个转模块会让每个
      // 相关测试文件多花 ~100s 导入并拖垮 worker。测试改用小样本替身
      // (property-icons.vitest-stub.ts), 形状与真模块一致。
      // 必须放在 '@features' 之前 —— alias 按顺序匹配, 数组形式才保证顺序。
      {
        find: '@features/document/properties/property-icons',
        replacement: resolve(
          frontendRoot,
          'features/document/properties/property-icons.vitest-stub',
        ),
      },
      { find: '@', replacement: frontendRoot },
      { find: '@app', replacement: resolve(frontendRoot, 'app') },
      { find: '@features', replacement: resolve(frontendRoot, 'features') },
      { find: '@platform', replacement: resolve(frontendRoot, 'platform') },
      { find: '@shared', replacement: resolve(frontendRoot, 'shared') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['app/flowix-web/**/*.test.{ts,tsx}'],
    setupFiles: ['app/flowix-web/vitest.setup.ts'],
    // 不要打开 deps.optimizer: 它能把 @phosphor-icons/react 的 barrel 从 13.8s 压到
    // 0.2s, 但同时改变所有依赖的加载路径, 让 prosemirror/tiptap 拿到两份模块实例 ——
    // 全量实测 12 个文件 / 89 个用例因此失败 (editor/extensions 与 document-editing 为
    // 主)。要用预打包, 得先解决编辑器那套的模块身份问题。
  },
});
