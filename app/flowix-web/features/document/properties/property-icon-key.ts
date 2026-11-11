/**
 * 图标 glob 的 key 解析。
 *
 * `property-icons.ts` 用 `import.meta.glob(..., { base })` 把 key 收窄成
 * `<分类>/<id>.svg`（省掉每条重复的目录前缀，这张表会原样进启动图）。
 * 解析独立成纯函数：vitest 里真模块被 `property-icons.vitest-stub.ts` 替掉，
 * 这是唯一能在测试里锁定 key 形状的地方 —— vite 改了 glob key 的生成方式
 * （例如退回完整相对路径或绝对路径）时，这里必须先红。
 */
export function parsePropertyIconKey(key: string): { category: string; value: string } | null {
  const parts = key.replace(/^\.\//, '').split('/');
  if (parts.length !== 2) return null;
  const [category, file] = parts;
  const value = file.replace(/\.svg$/i, '');
  if (!category || !value) return null;
  return { category, value };
}
