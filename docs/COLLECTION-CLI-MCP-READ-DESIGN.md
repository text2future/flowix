# 集合 CLI / MCP 读取补充设计

日期：2026-11-02。状态：已接入 CLI 与 MCP。非 Markdown 文件正文读取继续由后续 `file.read` 扩展。

## 1. 目标与结论

沿用现有 CLI 和单一 MCP `memo` 工具，完成以下读取链路：

```text
notebooks → collection list → collection describe → collection query → show <address>
```

这里有两种列表：`collection list` 列出笔记本里的集合，`collection query` 列出一个集合中的实际条目。两者均分页。列表必须返回可继续调用的定位信息，AI 无须读 YAML、猜路径或自行拼装文件地址。

本期覆盖 notes、media、work_documents 和 v3 hybrid 集合的目录、结构、条目元数据；笔记正文复用现有 `show`。非 Markdown 文件先明确读取能力，后续增加独立的文件内容读取入口。

## 2. 现有实现审查

| 位置 | 当前行为 | 对设计的影响 |
| --- | --- | --- |
| `app/flowix-cli/src/cli.rs` | 已有 `collection read --notebook ... --id/--path ...`，没有集合列表、查询命令 | 增量扩展 `collection` 命令组 |
| `collection_store.rs::read` | 返回集合元数据和完整原始 payload | `records.include` 不能当成实际数据列表 |
| `collection_store.rs::find_by_id` | 先查 notebook.db，再扫描源文件回退 | 保留文件权威、索引可重建的原则 |
| `collection_store.rs::collection_type` | 候选文件包含 index/table/lib，但未识别 `.workdocs.yaml/.yml` | 后面的校验虽然支持 workdocs，前面的候选识别仍会挡住旧后缀 |
| `collection_store.rs::find_by_id` | 索引命中合法文件后立即返回 | 同 ID 的未索引副本可能未被发现，完整扫描才能确认冲突 |
| `operation.rs` | 已有传输无关的 `FlowixOperation::CollectionRead` | 所有新读取走同一业务层 |
| `mcp.rs` | 结构化 action 和旧 command 并存；旧命令解析不启动 shell | 保留结构化 action 为主，旧命令兼容 |
| `memo-tool-schema.json` / `mcp.rs` | schema 声明 `id`，执行层允许并要求 `address` | 修复正文读取契约，增加 schema 与执行一致性验证 |
| `path_store.rs::show` | 按 `notebookId::relativePath` 读取笔记，返回 body | 笔记正文入口已经存在，不引入 memo ID |
| `operation.rs::List` / CLI List | 结构化 MCP list 有 limit/offset；CLI 没有对应参数，旧 MCP command 另走返回分支 | 新集合命令从第一版统一分页和返回结构；旧笔记列表另行兼容 |
| `flowix-core/src/collection.rs`、hybrid fixture | 支持 v3 hybrid、多个 domain | 不能只照旧 v2 文档实现 |
| `docs/COLLECTION-INDEX.md` | 部分说明仍是 v2、单域模型 | 实现时同步更新，不把旧文档当成最新协议 |

审查基于当前工作树，包含未提交的集合变更；本设计不覆盖这些文件。

特别注意：UI 对自动收集记录使用会话内生成的 row ID。CLI 不应把该 ID 当成文件身份，更不能为读取生成并保存记录。

## 3. 借鉴 Notion 的边界

参考官方 [Supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)：`notion-fetch` 读取 page/database/data source/view 的内容或定义；`notion-query-data-sources` 查询条目，包括按保存视图读取。列表结果带可继续 fetch 的身份。

Flowix 借鉴三点：发现集合、理解 schema、查询记录与读取正文分层；查询结果包含直接可读的 locator；视图定义与视图实际结果分开。

Flowix 保留自己的实现：本地文件和现有 Rust operation 层是核心，MCP 是薄适配；不增加远端 Notion 依赖，不为本期引入 SQL 或新的数据库身份体系。Notion 的 data source 对应 Flowix 的单域 dataset，hybrid 通过 domain 明确选择。

## 4. CLI 完整命令面

下表标为“新增”的均为拟议接口。

| 命令 | 状态 | 用途 |
| --- | --- | --- |
| `flowix notebooks --json` | 已有 | 发现笔记本 |
| `flowix collection list [<notebook>] --limit 50 --offset 0 --json` | 新增 | 列出集合，缺省使用现有当前笔记本解析器 |
| `flowix collection describe --notebook <nb> --id <col> --json` | 新增 | 集合身份、各域 schema、来源、视图和能力；不带大批 records |
| `flowix collection read --notebook <nb> --id <col> --json` | 保留 | 完整原始定义，兼容现有返回和调用 |
| `flowix collection query --notebook <nb> --id <col> --domain notes --limit 50 --offset 0 --json` | 新增 | 读取实际条目元数据和字段值 |
| `flowix show '<nb>::<relative-path>' --json` | 已有 | 读取单篇笔记正文 |

所有针对一个集合的命令同时支持 `--path <notebook-relative-path>`，与 `--id` 恰好二选一。不得将 CLI 的 `--id` 误解释为笔记 ID。

`list` 增加 `--type table|media_library|work_documents|hybrid`、`--domain notes|media|work_documents`、`--query <名称或路径关键词>` 和 `--snapshot <token>`。type 按存储类型筛选，domain 按数据域能力筛选；两者同时提供则取交集。查询不做正文全文搜索。

`query` 支持：

- `--domain`：单域集合可省略并返回推导结果；hybrid 必填，避免静默漏域。
- `--view <viewId>`：省略表示整个 dataset；提供则附加该视图的筛选、排序。视图不存在或域不匹配必须报错。
- `--query <文本>`：只在集合成员中按标题、相对路径匹配，不宣称检索正文。
- `--fields <逗号分隔字段ID>`：控制返回属性；省略返回域 schema 中的字段，不输出全部无关 frontmatter。筛选、排序在投影前执行。
- `--sort <fieldId或内置字段>:asc|desc`：可重复；显式指定时替代视图排序，未指定则使用视图排序或默认排序。
- `--limit`：默认 50，范围 1–200；`--offset`：默认 0，非负。
- `--snapshot <token>`：后续分页使用首批返回的 token，防止数据变更导致无提示漏读。

第一期查询直接复用保存的 dataset/view 筛选，新增任意条件 DSL 可后置，不能因此省掉现有筛选求值。

## 5. 返回契约

新增接口统一返回 `ok`、`action`、`notebookId` 和 camelCase 分页字段。保留旧命令已有字段，不全局修改旧 `next_offset` 格式。

集合列表例子（ID 为示例）：

```json
{
  "ok": true,
  "action": "collection.list",
  "notebookId": "work",
  "items": [{
    "collectionId": "col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "name": "项目",
    "type": "hybrid",
    "placement": "folder",
    "relativePath": "项目/.index.yaml",
    "domains": ["notes", "media", "work_documents"],
    "revision": 7,
    "state": "valid"
  }],
  "page": {"limit": 50, "offset": 0, "returned": 1, "total": 1, "hasMore": false, "nextOffset": null},
  "snapshot": "opaque-token",
  "complete": true,
  "diagnostics": []
}
```

列表默认不计算每个集合的实际行数，不加载正文；total 仅指本次筛选后的集合数量。无效集合仍返回 relativePath 和诊断，能解析多少身份就返回多少；不能识别的字段为 null。重复 ID 的条目标记 `identityConflict`，允许 AI 用 path 看指定副本定义，但按 ID 操作报冲突。

`describe` 返回 `collection`、`domains[]`、`views[]`、`capabilities`。每个域列出 source、schema、datasetFilter、是否默认启用自动收集；每个视图列出 viewId/domain/filter/sort/default。返回格式版本和集合 revision，排除 `records.include/exclude` 的完整数组以控制体积；需要原始数组时使用已有 read。

集合查询例子：

```json
{
  "ok": true,
  "action": "collection.query",
  "notebookId": "work",
  "collectionId": "col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "collectionRevision": 7,
  "domain": "notes",
  "viewId": null,
  "items": [{
    "recordId": null,
    "origin": "automatic",
    "kind": "note",
    "state": "available",
    "title": "发布计划",
    "relativePath": "项目/发布计划.md",
    "address": "work::项目/发布计划.md",
    "properties": {"fld_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": "进行中"},
    "read": {"action": "show", "address": "work::项目/发布计划.md", "available": true}
  }],
  "page": {"limit": 50, "offset": 0, "returned": 1, "total": 1, "hasMore": false, "nextOffset": null},
  "snapshot": "opaque-token",
  "complete": true,
  "diagnostics": []
}
```

字段约定：

- `recordId` 只返回已持久化的集合局部记录 ID；自动收集记录为 null。文件 locator 是 address。
- `properties` 按 fieldId 返回类型化值，字段名称、property_key、类型和选项由 describe 的 schema 给出。缺值为 null，Boolean false 与 Number 0 必须保留。
- include 中未关联文件的草稿：`state=draft`，address/read.address 为 null，read.available=false。
- 显式引用的文件已删除：`state=missing`，保留引用路径，read.available=false；不要当成空正文。
- media/work_documents 返回 kind、mimeType、sizeBytes、createdMs、modifiedMs、可用 resourceId、address；当前 `read.available=false`、`read.reason=unsupportedContentType`，不能给这些文件伪造 `show` 能力。
- 任一列表或查询为空，items 为 []；有扫描/解析失败则 complete=false 并返回 diagnostics。不能把不完整结果报告成完整空集。
- 超过响应字节预算时返回更短页，nextOffset 按实际返回数推进；单条元数据过大要明确报错或标记截断，不能丢字段后伪装完整。读取结束以 hasMore=false 为准。

## 6. 实际条目的求值规则

CLI 必须执行集合规则，不能返回 include 数组冒充集合数据。当前笔记 UI 的实现在 `table-document-view.tsx` 的 conditionRecords、scopedExplicitRecords 和 visibleRecords。

笔记域按当前 UI 语义定义：

```text
explicit = source 范围内的 include（保留草稿和失效引用）
automatic = source 范围内、满足 dataset.filter 的现有笔记
            去掉已显式关联路径和 exclude 路径
dataset = explicit + automatic
result = dataset → 可选 view.filter → query 文本匹配 → 排序 → 分页 → 字段投影
```

这里 exclude 阻止自动收集，不直接覆盖显式 include。不要未经说明改成 `(include ∪ automatic) - exclude`。已有显式行的顺序和 ID 保留；自动成员按文件地址去重。若持久化显式记录本身重复引用文件，保留各行并给出诊断，避免静默损失用户行。

`dataset.filter=null` 表示不自动收集；空条件且 filter 非 null 可以收集整个 source 范围。兼容新 `{path,match,conditions}` 与旧 all/any 布尔组，不得把旧复杂条件简单扁平化。

source 的 containing_folder 根据集合当前位置计算；folder 使用 source.path；notebook 使用笔记本根。数据域固定递归读取位置下的匹配内容，目录比较按路径段进行，`A` 不匹配 `AB`；文件树单独固定为只展示第一层。旧 source.depth 仅为读取兼容字段，不能改变读取范围，写回时移除。文件夹 dataset.filter.path 的重定位沿用 `dataset-filter-location.ts`，不能使用移动前的旧路径。

媒体和工作文档分别复用对应域的成员、类型过滤和资源属性规则。hybrid 每次只查询所选域，校验 view.domain。Rust 求值与前端用同一批 fixture 比对；若现有前端分支对某个边界不一致，先明确统一语义，不能把前端实现缺陷当隐含接口。

默认无视图时按显式行顺序在前、自动成员 relativePath 升序在后；使用视图/显式 sort 时按指定排序，最后追加 address、recordId 作为确定性平局键。null、日期、大小写和多值字段比较规则须固定并由跨端 fixture 验证。

## 7. 全量发现、分页与一致性

列表以源文件为准：扫描允许索引的目录，包含根目录和各层目录 `.index.yaml`、独立 `*.index.yaml`、历史 table/lib/workdocs 后缀。后缀只发现候选，实际类型以文件内容为准。继续使用 FileManagementPolicy，区分索引范围与显式路径访问范围。

索引只能加速和提供诊断；不能仅依赖 collection_documents 认为列表已完整。目录遍历不跟随符号链接，所有路径 canonicalize 后检查笔记本边界。数据库用只读方式打开，读集合不创建/迁移数据库，不保存 YAML，不切换默认视图。

集合 ID 操作必须识别允许发现范围内的全部同 ID 文件。损坏文件不能悄悄从目录消失；权限或 I/O 失败须标识结果不完整。

第一页创建无服务端会话依赖的 opaque snapshot token，绑定 notebook、集合选择器、domain、view、筛选/排序/投影参数和输入指纹；limit/offset 不参与查询身份。后续请求沿用同一个 token。

输入指纹必须覆盖集合内容以及候选成员、参与筛选排序的属性和文件元数据。单用 collection.revision 不够：笔记 frontmatter 或新文件变化不会自动改变集合 revision。列表指纹覆盖候选集合集合及解析内容。跨进程、跨 CLI/MCP 调用须可验证；可采用版本化查询摘要 + 内容摘要，不要求持久化快照文件。

本期采用重新求值、变更即拒绝的模式：扫描/求值前后检查输入，变化返回 `DATA_CHANGED`，建议从 offset=0 重读；稳定输入才生成结果。不是历史快照服务。若无法可靠检测并发输入变化，必须声明 consistency=bestEffort，不能承诺严格快照。大数据量可后续升级为受限生命周期的物化快照。

不传 snapshot 允许独立分页，但返回一致性说明。AI 完整枚举时必须传 token、一直翻页，不能把第一页当全量。

## 8. MCP 与 CLI 一一对应

保留 `flowix mcp`，保留唯一工具 memo，新增三个 action：

| CLI | MCP 参数 |
| --- | --- |
| collection list work | `{"action":"collection.list","notebook":"work","limit":50,"offset":0}` |
| collection describe --notebook work --id … | `{"action":"collection.describe","notebook":"work","collectionId":"col_…"}` |
| collection read --notebook work --path 项目/.index.yaml | `{"action":"collection.read","notebook":"work","path":"项目/.index.yaml"}` |
| collection query --notebook work --id … --domain notes | `{"action":"collection.query","notebook":"work","collectionId":"col_…","domain":"notes","limit":50,"offset":0}` |
| show work::项目/发布计划.md | `{"action":"show","address":"work::项目/发布计划.md"}` |

list 的额外参数为 type/domain/query/snapshot；query 的额外参数为 viewId/query/fields/sort/snapshot。fields 为字符串数组，sort 为 `{field,direction}` 数组。schema 用 action 条件约束参数和二选一选择器；Rust 运行时执行相同校验，不能只依赖客户端 schema。

修复 schema 的 address 定义和所需字段；当前 Rust 不接受 id，不应仅为迁就错误 schema 新增“memo ID”概念。若确认有历史客户端依赖 id，才以明确版本兼容别名处理，不容许 id/address 同时传入。

新增 action、CLI 以及 legacy command 都映射到同一个 FlowixOperation，返回同一业务 JSON。MCP 继续将该 JSON 放入 structuredContent 和文本 content，业务失败 isError=true。保留单工具现有保守 annotations；不能因新增只读 action 就把包含 delete 的整个 memo 标成只读。

tool description、initialize instructions、工具 schema、launcher 缺 CLI 时的描述、README 和代理层说明同步更新。描述明确告知 AI：先 list，必要时 describe，再 query；将返回 read 对象用于正文读取；hasMore=true 必须翻页。

## 9. 后续单个文件内容读取

本期笔记已闭环：query 返回 address → show(address) 返回 body，不新增 `collection row read` 来重复笔记服务。

下一期增加 `flowix file read <address>` / `memo(action="file.read", address=...)`，由读取器注册表支持文本、PDF、Office、插件产物等；返回 mimeType、format、content、truncated 和 continuation。图片/视频提供可用资源引用或媒体读取能力，不把二进制当 UTF-8。具体解析器、分页单位和 MCP 图像传输另定。

未来能力就绪后，只需把 query 对应条目的 read 改为 `{"action":"file.read","address":"…","available":true}`。文件地址体系保持不变，媒体 resourceId 仍只是已有资源身份，不能代替统一 address。

超长 Markdown 的分段读取也可补到 file.read；现有 show 保持兼容，不擅自改变 body 格式。

## 10. 错误与实施落点

沿用现有退出码：参数错误 2、找不到 3、冲突/数据变更 4、I/O 5、其他 1。新增集合错误在 error.details.reason 中保留具体原因，不只使用模糊字符串。

具体 reason 包括 COLLECTION_IDENTITY_CONFLICT、UNSUPPORTED_COLLECTION_VERSION、INVALID_COLLECTION、DOMAIN_REQUIRED、VIEW_DOMAIN_MISMATCH、VIEW_NOT_FOUND、DATA_CHANGED、UNSUPPORTED_CONTENT_TYPE。不支持的筛选/排序报错，不静默放宽条件。

实施顺序：

1. 修复 schema address 契约、workdocs 候选识别、只读索引访问及 ID 冲突检测，建立 CLI/MCP 一致性测试。
2. 在 collection_store 拆出 locate/scan/describe，增加 list/describe 的类型化响应；接通 cli/dispatch/operation/mcp。
3. 在 flowix-core 增加传输无关 collection_query 求值模块，复用现有笔记与媒体服务取元数据；CLI store 只负责适配和序列化。不可依赖 Tauri command 或 React hook。
4. 完成各域 query、属性展开、视图筛选排序、分页/字节预算/变更检测，更新共享 schema 和 AI 说明。
5. 同步集合协议文档，完成端到端读取验收。file.read 独立后续迭代，不阻塞笔记正文链路。

主要文件：`app/flowix-cli/src/{cli,dispatch,operation,collection_store,mcp,errors}.rs`、`app/flowix-core/src/collection.rs` 及新增求值模块、`dsh-flowix-memory/{memo-tool-schema.json,launcher.mjs,README.md}`、CLI 与 MCP 测试。

## 11. 验收标准

- 只通过公开 CLI 可完成 notebooks → 分页列出全部集合 → describe → 分页获取实际成员 → show 返回笔记正文；MCP 同样成立，返回业务数据一致。
- 不运行桌面端、没有 notebook.db、索引过期、集合外部移动后均可读取；只读集合操作不新增数据库、不改集合文件、不保存默认视图。
- fixture 覆盖 v1/v2/v3、folder/standalone、notes/media/work_documents/hybrid、历史文件名和根目录 `.index.yaml`。
- 覆盖自动成员、显式成员、exclude、重复引用、草稿、删除文件、null filter、空条件、旧嵌套布尔组、路径段、递归数据域和第一层文件树。
- schema 字段类型、零值/false、日期、空值、视图筛选排序与 UI 对照；无 view 时不意外应用默认视图。
- 稳定输入下逐页拼接等于单次完整求值；翻页中修改 frontmatter、新增/删除文件或改视图，携带 snapshot 返回 DATA_CHANGED。
- 损坏集合、未知版本、身份冲突、部分扫描失败明确可见；权限、路径越界、符号链接不造成漏报或越界读取。
- schema 实际允许 show.address，真实 tools/list → tools/call 测试能跑通；legacy command 和结构化 action 对新增命令返回一致。
- media/work_documents 列表可读但正文能力未实现时明确返回 unsupportedContentType，AI 不误调用 show。

实现已接入 `flowix-cli`、operation 层、MCP `memo` schema 和 README。运行 `cargo check -p flowix-cli` 通过；本次未执行功能测试。
