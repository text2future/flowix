---
name: flowix-note
description: 在 Flowix 默认笔记本 (nb_default) 写一条「本次修复问题」笔记。标题 `N<月日>-<标题>`，正文按问题描述/环境/复现/原因/建议方法/修复方法 六段。
metadata:
  short-description: 在 Flowix 默认笔记本写一条修复笔记
---

# Flowix Note

把一次修复沉淀到 Flowix 默认笔记本 (`nb_default`, `~/Documents/flowix/`)。
**走项目自带 CLI** 写盘,不要直接编辑 .md ── 绕开 CLI 会让 `index.json` 漏同步。

## CLI

```
FLOWIX_CLI="/Users/rop/Desktop/flowix-main/app/flowix-desktop/binaries/flowix-cli-aarch64-apple-darwin"
```

> macOS arm64 默认路径。换 host 后跑 `bash scripts/build-cli.sh` 重编,
> 用 `FLOWIX_CLI` 环境变量覆盖。

## 触发

用户说"记录一下 / 写个 fix 笔记 / 存到 Flowix / 写一条修复记录",或执行 `$flowix-note`。

## 工作流

1. **收集六要素**(缺则追问一次):
   - `title` 一句话问题描述
   - `env` 日期(本地 `YYYY-MM-DD`)、产品模块、版本(无则 `N/A`)
   - `repro` 复现步骤或现象
   - `root` 根因,带 `path:file:line` 引用
   - `suggest` 建议方法(可与 fix 合并)
   - `fix` 修复方法,带 `path:file:line` 引用

2. **构造标题** ── `N<月日>-<title>`,本地时区,月日两位补零:
   - `printf '%02d%02d' $(date +%-m) $(date +%-d)`
   - >60 字截断 + `…`

3. **拼 body**(markdown,H1 在最前),然后 stdin 写盘:
   ```bash
   body="$(cat <<EOF
   # N\${MMDD}-\${slug}

   ## 问题描述
   ...

   ## 环境信息
   - 日期: \${DATE}
   - 产品模块: ...
   - 版本: ...

   ## 问题复现
   ...

   ## 问题原因
   ...

   ## 建议方法
   ...

   ## 修复方法
   ...
   EOF
   )"
   "$FLOWIX_CLI" new nb_default - <<< "$body"
   ```

4. **回报** ── 把 CLI 的 `id` / `title` / `file` + body 六要素给用户。

## 行为约束

- 默认笔记本 `nb_default`。用户说"写到工作笔记"等改用对应 id/name。
- 重复检测:`flowix-cli list nb_default | grep '<title>'` 命中则提示并跳过。
- 不加版权/license header,不附 emoji。
- 日期用本地时区(Asia/Shanghai),不用 UTC。
- 缺要素写 `N/A` 而不是省略小节。

## 自检

- [ ] 标题 `N<月日>-<title>`,月日两位
- [ ] 六要素全有
- [ ] 环境信息含本地日期
- [ ] 根因/修复带 `path:file:line`
- [ ] CLI 走 stdin(`new nb_default -`),不用 `$EDITOR`
- [ ] 退出码 0
- [ ] 回报含 `id` / `title` / `file`
