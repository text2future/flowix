# 笔记本内嵌入页面数据 API

日期：2026-11-14。状态：协议 `flowix.embed` v1 已实装。契约单一来源：`app/flowix-web/lib/html-embed-api.ts`。

本文是 `window.flowix` 的**唯一对外契约**。实现分别位于 `app/flowix-web/features/surface/html-data-bridge.ts`（宿主解析）与 `app/flowix-desktop/src/local_html_preview.js`（注入页面的 SDK）。改协议时三处一起改。

给写页面的人（尤其是 Agent）这几条命令，不用读本文也能上手：

```bash
flowix html                                        # 能力目录：每个 kind 的语义、参数、返回形状、坑、预算
flowix html --template workbench --out board.html  # 零 JS 工作台（声明式绑定）
flowix html --template table --out rows.html       # 选集合 → 渲染行 → 变更后重取
```

`--template` 不带 `--out` 就打印到 stdout；落盘请用 `--out`（直接写 UTF-8 字节）——Windows PowerShell 5.1 的 `>` 重定向会按控制台代码页编码，模板里的中文注释会变成乱码。目标已存在时拒绝写入，加 `--force` 才覆盖：`--out` 指向的通常是笔记本里的用户内容，重跑一次不该把改过的页面抹掉。

目录内容由 `scripts/gen-embed-catalog.mjs` 从契约生成（`app/flowix-cli/resources/embed-catalog.json`），`npm run check:embed-catalog` 保证不漂移；模板正文随 CLI 编进二进制，源码在 `app/flowix-cli/resources/templates/`。

## 1. 适用范围

| 打开方式 | 数据桥 |
| --- | --- |
| 笔记本目录内的 `.html` 文件，在 HTML 预览中打开 | 可用 |
| 插件产物（`srcDoc` 渲染） | 不可用 |
| `http://` / `https://` 网页 surface | 不可用 |
| 笔记本目录之外的 `.html` 文件 | 不可用 |

第 4 条的原因不是策略，而是机制：桥的授权范围（`notebookId` + 笔记本根路径）来自打开该文件的 surface。外部文件没有笔记本身份，笔记相关的请求（stats、views、custom-views、view-data）返回 `E_SCOPE`；`product-theme` 是宿主级能力，不依赖笔记本，仍会正常回答，页面因此至少能正确着色而不是整页空白。

用户打开笔记本内 HTML 页面即授权其使用当前笔记本范围内的 API，包括直接创建笔记、保存附件及修改页面提示状态；无需逐次确认。页面不能调用任意产品命令。只应打开信任的页面。

## 2. 协议

- 协议标识：`flowix.embed`
- 当前版本：`1`
- 页面可读 `window.flowix.protocol` 与 `window.flowix.version`。

调用形式：

```js
const payload = await window.flowix.request('notebook-stats');
```

请求消息（页面 → 宿主）：

```json
{
  "type": "flowix:local-html-data-request",
  "url": "asset://localhost/.../index.html",
  "protocol": "flowix.embed",
  "version": 1,
  "requestId": "fx-xxx-1",
  "kind": "view-data",
  "params": { "relativePath": "项目/.index.yaml", "viewId": "v1", "limit": 50 }
}
```

响应消息（宿主 → 页面）：

```json
{
  "type": "flowix:local-html-data-response",
  "protocol": "flowix.embed",
  "version": 1,
  "requestId": "fx-xxx-1",
  "ok": true,
  "payload": {}
}
```

失败时 `ok: false`，并带 `code`（稳定）与 `error`（人读文案，可能变化）。

**版本兼容**：不带 `protocol` / `version` 的请求按当前语义处理，v0 页面继续可用；一旦声明版本就必须完全匹配，否则返回 `E_UNSUPPORTED`。宿主不回退到旧语义，因为用错误形状回应一个声明了版本的页面比拒绝更糟。

## 3. 能力清单

| kind | params | 返回 |
| --- | --- | --- |
| `dismiss-html-notice` | `{ id }` | `{ dismissed: true }` |
| `capabilities` | 无 | `{ protocol, version, kinds, scope, authorization }` |
| `notes-list` | `{ limit?, sortBy?, order?, cursor?, includeImages? }` | `{ notes[{ relativePath, title, preview, createdAt, updatedAt, href, imagePreview? }], truncated, nextCursor }` |
| `upload-note-image` | `{ file: File }` | `{ relativePath }` |
| `select-note-images` | 无 | `{ images: string[] }` |
| `create-note` | `{ parentRelativePath, content, clientRequestId, images? }` | `{ relativePath, href }` |
| `notebook-folders` | 无 | `{ folders[], defaultRelativePath, defaultAvailable }` |
| `notebook-stats` | 无 | `{ notebookId, totalMemos, todoMemos, databaseCount, memoCount, topTags[] }` |
| `notebook-views` | `{ cursor? }` | `{ collections[], truncated, nextCursor }` |
| `notebook-custom-views` | 无 | `{ filters[] }` |
| `view-data` | `{ relativePath, viewId?, limit?, cursor? }` | `{ collection, viewId, fields[], rows[], total, truncated, nextCursor }` |
| `product-theme` | 无 | `{ id, tokens{...} }` |

`databaseCount` 是当前笔记本集合索引中有集合标识的全部集合数量。

取数顺序：先用 `notebook-views` 拿集合的 `relativePath` 与 `views[].id`，再用 `view-data` 取行。`view-data` 不接受绝对路径，也无法枚举集合——这是有意的：页面的全部地址空间都必须先由 `notebook-views` 给出。

### 返回样例

`notebook-views` 的一项：

```json
{
  "name": "项目", "type": "table", "relativePath": "项目/.index.yaml",
  "href": "flowix://open?notebookId=nb-1&f=%E9%A1%B9%E7%9B%AE%2F.index.yaml",
  "inViews": true, "identityConflict": false,
  "viewsAvailable": true, "defaultViewId": "v1", "rowCount": 3,
  "views": [{ "id": "v1", "name": "全部", "layout": "table" }]
}
```

`view-data` 的数据集集合（`rows[2]` 是索引里查不到的记录）：

```json
{
  "collection": { "name": "项目", "type": "table", "relativePath": "项目/.index.yaml" },
  "viewId": "v1",
  "fields": [
    { "id": "f2", "name": "状态", "type": "select", "propertyKey": "status" },
    { "id": "f1", "name": "note", "type": "primary", "propertyKey": "note" }
  ],
  "rows": [
    { "id": "r1", "notePath": "项目/a.md", "title": "a", "updatedAt": 1799990000000,
      "tags": ["#idea"], "properties": { "status": "进行中" },
      "resolved": true, "href": "flowix://open?notebookId=nb-1&f=%E9%A1%B9%E7%9B%AE%2Fa.md" },
    { "id": "r3", "notePath": ".flowix/database/col-1/b.md", "title": "b", "updatedAt": null,
      "tags": [], "properties": {}, "resolved": false, "href": "flowix://open?notebookId=nb-1&f=.flowix%2Fdatabase%2Fcol-1%2Fb.md" }
  ],
  "total": 2,
  "truncated": false
}
```

`view-data` 的文件夹集合：`fields` 为 `[]`，`rows` 是目录内文档（`resolved` 恒 `false`，没有 frontmatter 可读），`total` 在还有下一页时为 `null`。

### `notebook-folders`

返回当前笔记本的可选文件夹。`folders` 每项包含 `name`、`relativePath`、`depth` 和 `isDefault`；首项是根目录，其路径与名称均为空字符串。`defaultRelativePath` 为配置的默认创建目录，空字符串表示根目录。最多扫描 5000 个目录项并返回 500 个文件夹；`truncated` 为 true 表示列表不完整，此时 `defaultAvailable: false` 也可能是默认目录未被扫描到。无效的默认路径会使请求失败。

### `dismiss-html-notice`

将关闭状态写入当前笔记本内的 HTML 文件。`id` 仅允许 1–64 位小写字母、数字或连字符；保存可能重新加载页面。

### `notes-list`

`includeImages: true` 时返回首张图片的缩略图 data URL（不可用时为 null），每页最多 10 条；优先使用 `images` 属性，其次使用正文首图。

分页时将返回的 `nextCursor` 作为下次请求的 `cursor`，并保持排序参数一致；`nextCursor` 为 null 表示没有下一页。笔记本变更后从首页重新读取，游标所指笔记被删除时应重新从首页读取。

返回当前笔记本的笔记，不优先置顶笔记。`sortBy` 可选 `createdAt`（创建时间）、`updatedAt`（更新时间）、`title`（标题），默认 `createdAt`；`order` 可选 `asc`、`desc`，默认 `desc`。不支持的排序参数返回 `E_INVALID`。`limit` 默认 30，范围 1–100；`truncated` 表示还有更多笔记。`href` 可直接用于打开笔记。笔记本发生变更后，通过 `onInvalidate` 重新请求。

### `upload-note-image`

传入 PNG、JPEG、GIF 或 WebP 的 `File` 对象（单张不超过 20 MiB），保存到当前笔记本 `attachments/` 并返回相对路径。附件立即保存，取消发布后仍会保留。

### `select-note-images`

打开系统图片选择窗口，所选图片立即保存到当前笔记本 `attachments/`，返回相对路径数组；取消返回空数组。每次最多选择 20 张。未发布或移除的图片仍保留在附件目录。

### `create-note`

可选 `images` 接收最多 20 个当前笔记本附件图片路径。创建时合并到 YAML 的 `images` 数组并标记为 `Image`；重试必须传入相同的图片数组。

`parentRelativePath` 是当前笔记本内的目标目录（空字符串表示根目录），`content` 为非空 Markdown，UTF-8 最多 65536 字节。`clientRequestId` 是每次新提交生成的 16–128 位字母、数字、下划线或连字符。宿主校验笔记本范围后直接创建笔记，成功后返回相对路径与可打开的 `href`。

新笔记的文件名取正文首个非空行，最多 100 个字符，并清理文件名不支持的字符；为兼容文件系统，文件名主体超过 220 个 UTF-8 字节时会进一步截短。同名文件使用数字后缀。

超时或错误时保留输入，以完全相同的参数和 `clientRequestId` 重试；同一标识不能用于不同内容。宿主记录请求回执，若中断后无法确认文件状态会拒绝自动重建，避免重复创建。旧版宿主对该请求返回 `E_UNSUPPORTED`。

### `notebook-stats`

笔记与标签聚合，`topTags` 最多 20 项，每项 `{ name, count, barWidth }`。`barWidth` 是相对最大标签的现成 CSS 宽度（如 `"62%"`），可直接绑定到进度条。`memoCount` 在索引尚未就绪时为 `null`。

### `capabilities`

返回当前宿主的协议、能力目录、页面范围（`notebook` / `external`）及授权方式 `open-page`。开发时 `flowix html` 来自本地安装的 CLI，版本可能与运行中的宿主不同；以宿主返回的目录为准。外部页面仅可使用宿主级能力，笔记本相关请求返回 `E_SCOPE`。

### `notebook-views`

笔记本内的集合清单，每页最多 50 个。用返回的 `nextCursor` 获取下一页；笔记本变更后从首页重新读取。每项 `{ name, type, relativePath, href, inViews, identityConflict, viewsAvailable, defaultViewId, views[], rowCount }`，`views` 只含 `{ id, name, layout }`。

`rowCount` 是集合文件里**内联登记**的行数（`dataset.records.include` 的长度）。筛选驱动的集合（工作文档、按条件筛选的表格）和文件夹集合的行数只有跑查询才知道，因此是 `null`——页面应把 `null` 当作"未知"，不要当作 0。用它挑默认卡片，就不必逐个集合发一次 `limit:1` 的探测请求。

`href` 是打开这个集合的链接（见 [点击打开](#点击打开)）。集合路径不是集合文件时为空字符串。

### `notebook-custom-views`

自定义视图过滤器，来自 `<notebook>/.flowix/system.json`。

### `view-data`

一个集合视图的实际行数据。`relativePath` 是**笔记本内相对路径**，指向集合文件（如 `项目/.index.yaml`），不是绝对路径，也不能包含 `.` / `..` 段。

返回的 `collection` 是 `{ name, type, relativePath }`，其中 `name` 与 `type` 来自笔记本的集合索引（集合文件里没有这两个字段）；索引里查不到时为空字符串，`relativePath` 原样回显。

**列定义**（仅数据集集合）：`fields[]` 每项 `{ id, name, type, propertyKey }`。

- `name` 是显示名，schema v2/v3 没有 label 字段时回退到 `propertyKey`，不会为空。
- `propertyKey` 是 `rows[].properties` 的键名，用于把列映射到 frontmatter 属性。`note` / `tags` / `flowix_icon` / `flowix_colors` 是产品内置键。
- `type` 统一小写，取值限下面这张表（未知类型按小写原样透传）：

| type | 含义 | `properties` 里的形态 |
| --- | --- | --- |
| `primary` | 笔记标题列 | 不出现（读 `rows[].title`） |
| `tag` | 标签列 | 不出现（读 `rows[].tags`） |
| `text` / `url` / `icon` / `color` / `image` | 文本与内置展示属性 | 字符串 |
| `number` | 数字 | number，也可能是数字字符串 |
| `boolean` | 勾选 | boolean |
| `date` | 日期 | `YYYY-MM-DD` 或带时间的字符串 |
| `select` | 单选 | 字符串 |
| `multi-select` | 多选 | 字符串数组 |

**行**：`rows[]` 每项 `{ id, notePath, title, updatedAt, tags, properties, resolved, href }`。

- `notePath` 一律正斜杠，相对笔记本根。集合文件里的 `note_path` 可能是内部路径（`.flowix/database/...`），也可能是被移动过的旧路径，因此**不能假定它一定在笔记索引里**。
- `id` 只保证「本次响应内唯一、跨请求稳定」：显式登记的行是集合里的记录 id，条件收集的行是宿主按路径派生的。它适合做 DOM key，**不要当持久标识**写入页面状态。
- `resolved` 说明笔记索引是否认识这个路径。`false` 时 `title` 回退为文件名（去扩展名），`tags` / `properties` 为空——用来区分"这条记录真的没内容"和"笔记不在索引里"。
- `href` 是可以直接放进 `<a href>` 的 `flowix://open` 链接，点了就在产品里打开对应笔记；非 `.md` 行（图片、文档）为空字符串。它只是一条链接，仍然走链接桥的同一套校验，不授予任何额外访问权。怎么用见 [点击打开](#点击打开)。
- `total` 是截断前的总行数；文件夹集合还有下一页时为 `null`（未知），不要拿 `rows.length` 冒充。
- `truncated: true` 表示本页之外还有行，**这是正常结果，不是错误**。后续页面可能为空（视图过滤在底层分页之后执行），仍需根据 `nextCursor` 继续读取。

**行是怎么来的**（按集合类型，与产品界面同一套规则）：

| 集合类型 | 行来源 | `total` / `truncated` |
| --- | --- | --- |
| 表格（笔记） | 显式登记的记录 + 条件收集的笔记，再套用**该视图**的筛选与排序——与表格界面显示的集合、顺序一致 | `total` = 视图可见行数 |
| 工作文档 | 与列表界面同一个分页查询，集合保存的文件名 / 类型 / 目录条件下推给查询；视图级筛选作用在本页 | 还有下一页时 `total` 为 `null`，`truncated: true` |
| 媒体库 | 显式登记的文件记录（记录里是 `relative_path`） | `total` = 记录数 |
| 文件夹 | 该目录内的文档分页清单 | 还有下一页时 `total` 为 `null` |
| hybrid（v3） | 按 `viewId` 所属的**数据域**选上面某一行来源；不传 `viewId` 时取默认域 | 随所选类型 |

因此「界面里看得到行、页面里是 0 行」不再是常态：筛选驱动的表格也会出行，`viewId` 的筛选与排序同样生效。

两点边界：媒体库与文件夹集合**不套用**视图的筛选/排序（它们的行就是登记的文件、目录清单），传 `viewId` 只是回显；表格集合的行会先经过集合自身的数据域条件，所以个别历史记录可能比 `dataset.records.include` 里登记的少——这与表格界面一致。

`viewId` 回显的是**实际生效**的视图 id（不传时是集合的默认视图），页面可用它显示「当前视图」。

文件夹集合：`fields` 为空，`rows` 是该目录内的文档，`properties` 恒为 `{}`，`resolved` 恒为 `false`。工作文档、媒体库的行同理：它们是文件而不是笔记，`resolved` 为 `false`、`href` 为空。

`limit` 默认 50，范围 1–200。使用返回的 `nextCursor` 获取下一页，保持 `relativePath`、`viewId` 和 `limit` 不变。数据变化后从首页重取；游标不是快照。

视图身份是「集合文件 + viewId」：viewId 只在单个集合文件内唯一。

### `product-theme`

当前产品主题，`tokens` 含 `background`、`foreground`、`secondaryForeground`、`mutedForeground`、`border`、`brand`、`card`。主题切换时宿主推送 `flowix:local-html-data-changed`（`kinds: ["product-theme"]`），声明了 `theme` 的页面会自动重拉，命令式页面可自行监听后重新 `request`。

这个 kind 不依赖笔记本：文件不在任何笔记本目录内时也照常回答。

### 点击打开

宿主提供**链接**，做可点跳转时把现成的 href 挂上即可：

```html
<a href="flowix://open?notebookId=nb-1&amp;f=%E9%A1%B9%E7%9B%AE%2Fa.md">a.md</a>
```

两个来源：

| 来源 | 指向 | 什么时候为空 |
| --- | --- | --- |
| `rows[].href` | 那一行对应的笔记 | 行不是 `.md`（图片 / 文档 / 文件夹清单里的文件） |
| `collections[].href` | 那个集合本身（点开就是集合界面） | 集合路径不是集合文件 |

三条边界：

- **空字符串就是没有可打开地址**，别拿 `notePath` / `relativePath` 去补。页面拿不到打开图片、文档、文件夹的能力，这不是遗漏：那些 surface 需要资源上下文，链接桥给不了。
- **别自己拼地址**。`file://` 绝对路径和相对路径都按"外部文件"解析：单个文件还能打开，文件夹打不开，页面被移到别的目录后失效，跨笔记本也解析不到。宿主给的 href 是笔记本内深链，三者都不受影响。
- **href 是链接，不是授权**。点它走的是链接桥的同一套归属校验（和笔记正文里的链接一样），越界的路径在那里被拒；`rows[].href` 永远指向本文档所属笔记本之内的路径。

## 4. 声明式模板（推荐）

不写 JS 也能绑数据：

```html
<meta name="flowix-data" content="stats views">
```

可用 key：`stats` → `notebook-stats`，`views` → `notebook-views`，`custom-views` → `notebook-custom-views`，`theme` → `product-theme`。页面加载后按 key 自动拉取首页，合并成 `{ stats, views, ... }` 并渲染。`views.truncated` 为 true 时，命令式请求 `notebook-views` 的 `nextCursor` 才能继续读取。

绑定语法：

| 属性 | 用途 |
| --- | --- |
| `data-fx-text="stats.totalMemos"` | 文本插值 |
| `data-fx-attr="title:item.name"` | 整个属性绑定（`属性名:路径`） |
| `data-fx-style="width:item.barWidth"` | 单个 CSS 属性（`属性名:路径`） |
| `<template data-fx-each="views.collections">` | 列表循环，可嵌套，默认单项作用域为 `item` |
| `<template data-fx-each="item.views" data-fx-as="view">` | 嵌套循环时给内层改名，否则内层 `item` 会遮蔽外层 |
| `data-fx-if="views.collections.length > 0"` | 条件显示（`==` `!=` `>` `<` `>=` `<=`） |

`style` 不能用 `data-fx-attr` 绑定：那会把整个 `style` 属性替换成单个值（`style="62%"` 无效）。需要宽度、颜色这类单属性时用 `data-fx-style`。

路径解析先查 `item`，再回落到根对象。数组在条件判断中按「非空」为真。

命令式补充：`window.flowix.render(root)` 手动渲染，`window.flowix.onData(cb)` 订阅更新，`window.flowix.onInvalidate(cb)` 订阅「底层数据变了」（见 §6），`window.flowix.data` 读最近一次结果。

`onInvalidate` 是命令式页面的刷新入口：`<meta>` 里声明过的 kind 会自己重拉，用 `request('view-data')` 取的行不会。回调收到 `{ kinds }`，`kinds` 为 `null` 表示宿主没指明范围。

## 5. 错误码

| code | 含义 | 页面应对 |
| --- | --- | --- |
| `E_UNSUPPORTED` | 未知 kind，或协议/版本不匹配 | 不要重试，降级渲染 |
| `E_SCOPE` | 路径非法、视图不存在、笔记本不可用（含文件不在笔记本内） | 提示用户检查文件位置 |
| `E_INVALID` | 参数或游标无效 | 修改参数后重试 |
| `E_TIMEOUT` | 请求超时，写入结果可能未知 | 创建笔记时保留相同参数和 clientRequestId 重试 |
| `E_BUSY` | 并发请求超出预算 | 稍后重试 |
| `E_INTERNAL` | 宿主读取产品数据失败 | 可重试一次，仍失败则降级 |

`truncated: true` 不产生错误码。

## 6. 限制与配额

| 项 | 值 |
| --- | --- |
| 单次请求超时（页面侧） | 读取 15 s；创建笔记、选择和上传图片 300 s |
| 并发的请求数 / 页面 | 16（超出时页面侧直接 reject，不发消息） |
| 并发的请求数 / 宿主 | 16（与页面侧同额，超出返回 `E_BUSY`） |
| 宿主读取缓存 TTL | 2 s（仅集合索引、集合文档解析与笔记索引列表；其余 kind 每次实时读取） |
| `view-data` 行数 | ≤ 200 |
| 集合数 / 标签数 | 每页 50 / 标签 Top 20；每个集合返回全部视图 |
| 字段数 / 属性键数 | 32 / 32 |
| 字符串字段 | ≤ 256 字符 |
| 数组属性 | ≤ 16 项，每项 ≤ 128 字符 |
| 行内标签 | ≤ 12 个 |

读缓存是短期的，并且**会主动失效**：笔记本内发生文件变更（编辑、新建、移动、删除，含外部编辑器写入）时，宿主清掉解析缓存并向页面推送 `flowix:local-html-data-changed`（不带 `kinds`，表示"全部"。主题切换只带 `kinds: ["product-theme"]`）。页面重载或自行 `request` 都会读到最新数据。

推送按 250 ms 合并，自动保存的连续写入只会触发一次重读。

## 7. 安全边界

- 预览 iframe 是 `sandbox="allow-scripts"`，**没有** `allow-same-origin`，因此页面处于不透明源：无法读 cookie、`localStorage`、`IndexedDB`，也无法直接调用 Tauri 命令。桥是唯一的通道。
- 宿主按 `event.source === iframe.contentWindow` 且 URL 归一化（去 hash）后一致来认消息，因为不透明源无法做 origin 校验。
- 返回值只含聚合数据：没有绝对路径、没有原始 YAML、不授予任何文件访问权。`rows[].href` 是现成链接而非授权凭据——点它走的是链接桥的同一套归属解析，跨笔记本或逃出目录的路径在那里被拒。
- 授权范围绑定在打开该文件的笔记本上，页面无法通过改参数跨笔记本读取。

**需要持久状态时写回笔记本文件**（笔记、集合行、frontmatter），不要依赖浏览器存储 — 它在这个环境里不存在。这并不是限制，而是让页面状态可同步、可被 Agent 读取的前提。

## 8. 最小示例

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="flowix-data" content="stats theme">
<title>笔记本概览</title>
</head>
<body>
<h1 data-fx-text="stats.notebookId"></h1>
<p>笔记 <b data-fx-text="stats.totalMemos"></b> 条</p>

<template data-fx-each="stats.topTags">
  <div><span data-fx-text="item.name"></span>
    <i data-fx-style="width:item.barWidth"></i></div>
</template>
</body>
</html>
```

命令式读取集合行：

```js
const data = await window.flowix.request('view-data', {
  relativePath: '项目/.index.yaml',
  limit: 50,
});
for (const row of data.rows) console.log(row.title, row.properties);
```

完整可运行示例：`examples/embedded-html-stats-demo.html`。

## 9. 类型声明

页面侧类型在 `docs/embed/flowix-embed.d.ts`：其中声明了 `window.flowix`、全部 kind 的入参与返回结构、行契约与字段类型词表。手写但受约束——`lib/html-embed-api.test.ts` 会断言它覆盖了每一个 kind 与每一个字段类型，漏写即红。

放进页面工程（或 `/// <reference path="flowix-embed.d.ts" />`）就能拿到补全与类型检查。

## 10. 非目标与弃用策略

**明确不做**（写清楚是为了避免页面按错误预期设计）：

- **修改已有内容**：没有修改已有笔记或集合的接口；`create-note` 仅支持创建新笔记。
- **任意文件读取**：没有"按路径读文件内容"的能力。行只带聚合字段与 `href`；要展示图片这类资源，用页面所在目录内的相对路径。
- **查询语言**：没有 SQL，也没有任意筛选表达式。需要条件取行，就在笔记本里建一个集合（表格的条件筛选、工作文档的文件名 / 类型 / 目录筛选），页面按集合取——条件属于笔记本，而不是页面。
- **分页一致性**：游标不是快照；笔记本变化时需要从首页重新读取。
- **跨笔记本**：授权范围绑定打开该文件的笔记本，改参数无法扩大。
- **细粒度变更流**：只有一个合并后的"数据变了"推送，没有逐条 diff。

**兼容与弃用**：

- v1 的 kind、参数、返回字段**只增不改**：新增字段一律可选，页面忽略不认识的字段即可。
- 要改字段语义或下线字段时：先在一个发布周期内于本文件与 `lib/html-embed-api.ts` 同步标注弃用，并先提供替代字段；下个周期才移除。
- 真正的破坏性改动必须换 `protocol` / `version`，让旧页面收到 `E_UNSUPPORTED`，而不是悄悄读到错值。
