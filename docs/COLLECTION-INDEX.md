# 集合协议与索引

多维表格、媒体库和文件夹集合共用集合协议。文件保存集合身份、数据集规则和视图；SQLite 仅是可重建的索引投影。

## 文件命名与集合身份

- 独立集合使用 `<名称>.index.yaml`。
- 文件夹集合使用该文件夹根目录下的 `.index.yaml`。一个文件夹只配置一个集合，类型只能是笔记集合或媒体库集合之一。
- 文件夹专用的 `.index.yaml` 始终不在笔记本文件树、访问空间文件树和目录文件列表中展示，也不能通过文件可见性设置显示；点击文件夹时仍会读取它并加载集合。
- 文件夹的 `.index.yaml` 通过 `collection.placement: folder` 标明用途；独立文件通过 `placement: standalone` 标明用途。文件名不决定集合类型，`collection.type` 决定是 `notes` 还是 `media`。
- `.table.yaml`、`.table.yml`、`.lib.yaml`、`.lib.yml` 继续作为旧文件名读取。新建及重命名后的独立集合使用 `.index.yaml`。
- 集合展示名称直接从路径推导：独立集合取文件名去掉扩展名；文件夹集合取 `.index.yaml` 的父目录名。新文件不写 `collection.name`；读取旧文件时忽略该兼容字段。
- 集合 ID 为创建时生成的 `col_` + 32 位 UUIDv7 十六进制字符串。名称、文件名和相对路径均不构成集合身份。

## 数据结构

外层格式版本和业务载荷版本同步递增。当前写入 schema v2；读取 schema v1 旧集合时先在内存中转换为 v2，单纯打开不改磁盘文件，后续编辑保存时写回 v2。集合层、数据集和视图各自承担独立职责：

导航、引用校验、文件夹类型切换和集合索引直接读取 v2 文档。现有表格与媒体编辑器在入口和保存处使用兼容适配，编辑器的旧字段不进入文件中的 `collection` 元数据。

```yaml
format: flowix.collection
schema_version: 2
collection:
  id: col_01900000000070008000000000000000
  type: notes                 # notes | media
  placement: folder           # standalone | folder
  revision: 0
  created_at: "2026-10-11T00:00:00.000Z"
  updated_at: "2026-10-11T00:00:00.000Z"
  properties: {}
payload:
  schema_version: 2
  dataset:
    source:
      scope: containing_folder # containing_folder | notebook | folder
    schema:
      primary_field_id: fld_01900000000070008000000000000001
      fields:
        - id: fld_01900000000070008000000000000001
          type: primary
          property_key: note
        - id: fld_01900000000070008000000000000002
          type: Text
          property_key: status
          name: 状态
    records:
      include: []
      exclude: []
    filter:
      path: null
      match: all
      conditions:
        - { field: kind, op: eq, value: note }
  views:
    default_id: view_01900000000070008000000000000001
    items:
      - id: view_01900000000070008000000000000001
        name: 表格
        layout: table
        filter: { all: [], any: [] }
        sort:
          - { field: modified_at, direction: desc }
        config:
          visible_fields:
            - fld_01900000000070008000000000000001
            - fld_01900000000070008000000000000002
```

`dataset.source` 只限定取数位置，不配置目录深度。图墙、列表和笔记等数据域固定递归读取该位置下满足筛选条件的内容；文件树固定只展示该位置的第一层。文件夹集合必须使用 `containing_folder`，路径由 `.index.yaml` 的实际父目录解析，不在文件内重复保存路径。独立集合可以使用整个笔记本范围，或用相对笔记本路径指定目录范围。旧文件中的 `source.depth` 会被忽略，并在下一次写回时移除。

`dataset.schema` 描述笔记属性字段；笔记属性值仍保存在各笔记 frontmatter。`records.include` 和 `records.exclude` 保存显式记录引用；笔记记录使用 `note_path`，媒体记录使用 `resource_id` 和 `relative_path`。尚未关联笔记的表格草稿行允许 `include.note_path: ""`。`dataset.filter` 保存规则取数条件。媒体集合当前不开放自定义字段，`schema.fields` 应为空；图片和视频身份仍由 `media_resources` 管理。

`dataset.filter: null` 表示不按规则自动收集，仅展示显式记录。数据集筛选使用 `{ path, match, conditions }`：`path` 是必须满足的笔记本相对目录前缀，`null` 表示不追加路径限制，空字符串表示显式选择全部目录；`match: all` 要求 `conditions` 全部满足，`match: any` 要求至少一项满足。整体逻辑固定为 `source 范围 AND path 匹配 AND 条件组匹配`。路径规则不放入条件数组，因此不会随交集 / 并集切换而失效。`path: null` 且空条件数组表示对来源范围自动收集全部记录。

文件夹集合的固定目录由 `.index.yaml` 所在文件夹决定，使用 `source.scope: containing_folder`，并将该目录相对笔记本根目录的路径写入 `dataset.filter.path`；路径选择在文件夹集合中禁用。这样表格、媒体库主视图和媒体库引用都按同一个固定目录筛选，移动 `.index.yaml` 时该路径随集合位置重定位；读取执行时也按当前位置解析有效路径，因此通过系统文件管理器移动后不会继续受旧路径限制，下一次保存会同步更新路径。独立集合的“浏览和保存”目录也写入 `dataset.filter.path`，同时用于保存新建笔记或媒体的目标目录。独立集合若另有 `source.scope: folder`，其来源边界仍由 `source.path` 定义。

读取时兼容旧版数据集规则筛选。可无损转换的简单旧规则会在用户下次保存时写成新结构；混有非空 `all` 和 `any`、或含嵌套分组的旧规则无法由单一 `match` 表达，编辑器会保留原规则并阻止覆盖。旧的路径规则会提升为独立的必需路径。`views.items[].filter` 仍使用视图筛选的 `all` / `any` 格式。

筛选器使用 `all`（全部满足）与 `any`（至少满足一项）；规则项允许再包含一层 `all`/`any` 分组。旧表格中“多个属性同时满足，或命中文件条件”转换为 `any: [{ all: [属性规则…], any: [] }, 文件规则…]`，保留原有匹配结果。

`views.default_id` 指向首次展示的视图；多维表格主动切换视图时将它更新为当前视图，通过已有的版本检查保存到文件。创建并打开新视图时一并更新，删除当前默认视图时一并回退，避免保存悬空 ID。嵌入文档优先使用引用节点记录的 `viewId`，其次使用文件的 `views.default_id`，目标不存在时回退到 `views.items` 的第一个视图。恢复视图不触发写入，只读浏览不更新文件或引用节点。旧文件中悬空的默认视图 ID 可以恢复为第一个视图，但视图定义本身仍须通过校验。

`views.items` 按集合类型保存布局、视图级筛选、排序和布局配置。点击文件夹时读取其 `.index.yaml`，用集合的默认视图打开；首次打开且尚未配置时，显示加载提示，在文件夹根目录创建笔记集合的 `.index.yaml`，随后打开多维表格视图。

## 媒体库数据集示例

```yaml
collection:
  type: media
  placement: folder
payload:
  schema_version: 2
  dataset:
    source: { scope: containing_folder }
    schema: { fields: [] }
    records:
      include:
        - id: rec_01900000000070008000000000000002
          updated_at: "2026-10-11T00:00:00.000Z"
          resource_id: media_01900000000070008000000000000003
          relative_path: 图片/参考.png
      exclude: []
    filter:
      path: null
      match: all
      conditions: []
  views:
    default_id: view_01900000000070008000000000000004
    items:
      - id: view_01900000000070008000000000000004
        name: 瀑布流
        layout: waterfall
        filter: { all: [], any: [] }
        sort: [{ field: created_at, direction: desc }]
        config: {}
```

上例展示的是完整 `payload` 的 `dataset` 与 `views` 内容；实际文件仍包含外层 `format`、`schema_version` 和完整 `collection` 元数据。

## 索引与变更

索引存放在 `<notebook>/.flowix/notebook.db`：

| 表 | 用途 |
| --- | --- |
| `collection_documents` | 按相对路径记录集合 ID、类型、名称、版本、revision、属性、时间、指纹和解析状态 |
| `collection_state` | 按集合 ID 保存本地展示偏好 |
| `collection_catalog_meta` | 索引结构版本与事件序号 |
| `collection_operations` | 保存改名、移动、属性修改的恢复日志 |

文件是集合元数据和业务内容的权威来源，索引可重建。索引从 `.index.yaml` 文件内容读取集合类型，因此相同后缀支持笔记和媒体两种独立集合；目录专用 `.index.yaml` 不作为独立集合入口显示。

集合 ID 索引不设唯一约束，以便显示复制产生的冲突。冲突集合禁止按 ID 操作；选定副本可生成新 ID，原集合、记录和视图 ID 保持不变。未知版本可进入索引，但不能编辑；无效文件保留诊断。

集合改名和移动通过 `notebookId + collectionId + expectedRevision + operationId` 定位最新内容并校验 revision。文件夹集合的路径固定为文件夹内的 `.index.yaml`，不允许单独改名或移出文件夹；移动文件夹时集合跟随文件夹移动。独立集合改名保留 `.index.yaml` 后缀。完成写入后刷新索引并发布集合变更事件。

## 展示身份与读取入口

`collectionId` 标识集合；`viewId` 标识集合内部视图；`displayId` 标识工作区中的展示身份。历史记录和展示描述按 ID 恢复，文件路径只作缓存提示。缺少集合、身份冲突、视图缺失或版本不支持时显示不可用状态。

桌面端统一使用 `list_collections`、`resolve_collection`、`mutate_collection`、`set_collection_display_state` 和 `make_collection_identity_unique`。CLI 与 MCP 保留 `collection.read` 读取原始 payload，并提供 `collection list` / `collection.list` 发现集合、`collection describe` / `collection.describe` 读取结构、`collection query` / `collection.query` 按数据域读取实际条目。查询会执行数据集来源、筛选及所选视图规则，返回可供现有 `show` / MCP `show` 使用的笔记地址。列表和查询支持分页及 snapshot 变更检测；集合 ID 仍是集合身份，笔记地址仍使用 `notebookId::relativePath`。

- 公共协议：`app/flowix-core/src/collection.rs`、`app/flowix-web/features/collection/model.ts`
- 索引和生命周期：`app/flowix-desktop/src/commands/collection.rs`
- 文件夹点击与导航：`app/flowix-web/features/memo/components/notebook-folder-view.tsx`、`app/flowix-web/features/workspace/use-cases/workspace-navigation.ts`
- 展示注册表：`app/flowix-web/lib/collection-display-registry.ts`
