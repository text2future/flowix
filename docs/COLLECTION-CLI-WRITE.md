# 集合 CLI：创建表格和字段

在笔记本目录中执行时，集合命令默认使用当前笔记本；也可以通过 `--notebook` 指定其他笔记本。优先使用结构化 JSON 新增记录，CLI 会按集合字段生成笔记的类型声明：

```json
{"title":"产品 A","properties":{"状态":"已核验","用途":["写作"],"评分":4.5},"content":"补充说明"}
```

```sh
flowix collection create --name '产品库' --fields-file fields.json --json
flowix collection add --path '产品库.index.yaml' --file record.json --request-id 'source-a-001' --json
flowix collection query --path '产品库.index.yaml' --where '状态=已核验' --fields '状态,评分' --json
```

`title` 用作笔记标题和文件名，同名时按现有规则增加后缀。`--request-id` 用于当前进程内的去重：相同 ID 和内容返回第一次的结果，内容不同时返回 `REQUEST_ID_CONFLICT`。进程退出后记录消失，独立 CLI 命令各自运行在不同进程中，无法依靠该 ID 跨命令去重。结果不明或进程重启后，请先查询是否已创建，再决定是否重试；中断后的自动恢复不受保证。旧版已创建的哈希文件仍按原有规则识别。没有请求 ID 时，每次调用都会新增记录。

字段错误返回 `INVALID_FIELD_VALUE` 和 `details.field`、`details.expected`，选择字段还提供 `details.allowed`。结构化写入期间字段定义发生变化时返回 `COLLECTION_SCHEMA_CHANGED`，调用方应重新读取字段后再决定如何重试。

`--where` 支持重复指定精确相等条件；选择字段可使用选项 ID 或标签，多选字段匹配其中一项，多个条件同时满足。数值和布尔值使用 JSON 写法。查询返回 `propertiesByKey` 供 Agent 直接读取，同时保留按字段 ID 索引的 `properties`。MCP 中对应 `collection.create`、`collection.add-fields`、`collection.add` 和 `collection.query`，分别使用 `fieldDefinitions`、`record`、`requestId` 和 `where` 参数。

关联笔记缺失时查询仍返回可用结果，`complete` 为 `false`，`diagnostics` 列出 `NOTE_MISSING` 和记录路径；即使筛选条件排除了缺失记录，诊断仍会保留。缺失状态变化会改变分页快照。

`collection create` 创建独立笔记表格，父目录必须已经存在。`--path` 是笔记本内相对路径，文件名必须以 `.index.yaml` 结尾，已有文件不会被覆盖。`--fields-file` 可选，文件为 UTF-8 JSON 数组：

```json
[
  {"name":"状态","type":"Select","options":["待调研","已核验"]},
  {"name":"用途","type":"MultiSelect","options":["写作","校对"]},
  {"name":"评分","type":"Number"},
  {"name":"网址","type":"URL"},
  {"name":"核验日期","type":"Date"}
]
```

名称默认同时作为笔记属性键；需要不同的键时提供 `property_key`。`flowix_plugin` 和 `flowix_property_types` 是保留键。支持 Text、URL、Icon、Boolean、Number、Date、Select、MultiSelect、Tag、Color 和 Image；Select 和 MultiSelect 必须提供非空选项。字段及选项 ID 由 CLI 生成，返回值和 `collection describe` 中可查询。

```sh
flowix collection create --notebook work --path '笔记/产品库.index.yaml' --fields-file fields.json --json
flowix collection add-fields --notebook work --path '笔记/产品库.index.yaml' --fields-file more-fields.json --json
flowix collection describe --notebook work --path '笔记/产品库.index.yaml' --json
flowix collection add-note --notebook work --path '笔记/产品库.index.yaml' --title '产品 A' --file product.md --json
flowix collection query --notebook work --path '笔记/产品库.index.yaml' --fields '状态,评分' --sort '评分:desc' --json
```

字段添加会更新表格和画廊视图中的可见列，使用内容比较检测并发修改。当前只支持独立笔记表格的创建和笔记表格的字段添加；混合集合的字段添加不支持。

笔记属性放在 Markdown YAML frontmatter；单选保存选项标签，多选保存标签数组，布尔和数字使用 YAML 原生值，日期使用 `YYYY-MM-DD`。为了让笔记属性编辑器也识别选择类型，可在 `flowix_property_types` 中声明类型：

```yaml
---
状态: 已核验
用途: [写作]
评分: 4.5
网址: https://example.com
核验日期: '2026-11-19'
flowix_property_types:
  状态: Select
  用途: MultiSelect
  评分: Number
  网址: URL
  核验日期: Date
---
```

`add-note` 在创建和关联前检查集合中已定义的字段值及已有类型声明，字段可省略或为 null；现有笔记不会在添加字段时自动迁移或验证。`add-note` 接收完整 Markdown，调用者负责类型声明；结构化 `add` 自动生成声明。`--fields` 接受字段 ID 或属性键。
