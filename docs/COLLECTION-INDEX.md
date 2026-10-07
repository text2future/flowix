# 集合索引与展示身份

## 身份和文件

多维表格（`table`）和媒体库（`media_library`）共用集合协议。集合 ID 是创建时生成的 `col_` + 32 位 UUIDv7 十六进制字符串，保存在文件中。名称、相对路径、所在目录均可变化，路径不用于生成身份。当前功能未上线，不提供旧格式迁移或兼容读取。

```yaml
format: flowix.collection
schema_version: 1
collection:
  id: col_01900000000070008000000000000000
  type: media_library
  name: 参考素材
  revision: 0
  created_at: "2026-09-21T11:33:20.000Z"
  updated_at: "2026-09-21T11:33:20.000Z"
  properties:
    owner:
      name: 负责人
      type: Text
      value: Alice
payload:
  schema_version: 1
  view:
    id: view_01900000000070008000000000000001
    layout: waterfall
    condition: {}
    sort: { field: created_at, direction: desc }
  records: { data: [] }
```

表格的业务结构位于 `payload.table` 和 `payload.records`。媒体库位于 `payload.view` 和 `payload.records`。集合属性独立于表格记录的笔记 frontmatter 和媒体资源属性，允许 Text、Number、Boolean、Date、URL、Icon、Color、Tag；属性键稳定，显示名称可改。集合属性通过底层协议及集合 ID/revision 管理，表格和媒体库不提供显性配置入口。

四种版本分别是公共文件 `schema_version`、业务 `payload.schema_version`、内容并发控制 `collection.revision`、SQLite 索引结构版本。索引更新另有单调 `indexSequence`，用于防止晚到事件覆盖新路径。未知版本可进入索引，但不能编辑；无效文件保留诊断。

## 统一索引

索引存放在 `<notebook>/.flowix/notebook.db`：

| 表 | 用途 |
| --- | --- |
| `collection_documents` | 按相对路径记录集合 ID、类型、名称、版本、revision、属性、时间、文件指纹和解析状态 |
| `collection_state` | 按集合 ID 保存视图分组等本地展示偏好 |
| `collection_catalog_meta` | 索引结构版本与事件序号 |
| `collection_operations` | 保存改名、移动、属性修改的恢复日志 |

文件是集合元数据和业务内容的权威来源，索引是可重建投影。集合 ID 索引不设唯一约束，以便显示复制产生的冲突。冲突集合禁止按 ID 操作；选定副本可生成新 ID，原集合、记录和视图 ID 保持不变。

集合目录统一扫描 `.table.yml/.table.yaml/.lib.yml/.lib.yaml`，失败扫描不清空可信索引。文件监视及文件管理动作刷新统一目录。媒体资源目录 `media_resources` 仍负责图片和视频文件，集合目录管理媒体库定义。

## 改名和移动

前端提交 `notebookId + collectionId + expectedRevision + operationId`，后端先按 ID 解析最新位置、确认内容身份及 revision，再校验目标路径和名称。改名同时更新 `collection.name`、revision、更新时间及文件名；属性修改保存最新业务载荷。移动通过 `targetRelativePath` 指定同一笔记本内的新位置。跨笔记本移动尚未提供。

写操作按跨进程文件锁、笔记本目录锁的顺序执行。日志先持久化，文件内容原子写入，目标文件禁止覆盖；仅大小写改名经过临时路径。完成后刷新索引并发布 `collection-changed`。启动及后续命令恢复未完成操作；无法完整提交时返回实际路径、名称、revision、内容和错误，界面采用实际结果。

## display id 和 history

`collectionId` 标识集合；`viewId` 标识集合内部视图；`displayId` 标识 surface 展示身份，形式为 `display:<随机 UUID>`。逻辑目的地 `(notebookId, collectionId, viewId)` 绑定稳定 display id，分配发生在导航阶段。

工作栏、浏览器栏和持久化恢复保存集合展示描述。改名通过目录事件重新绑定路径，保留 display id 和已有会话。改名不是导航，不增加历史、不清空前进栈。历史条目保存 display id、集合 ID、笔记本 ID 和视图 ID，路径仅为提示；前进后退重新按 ID 解析最新路径。

注册表保留当前、待打开、上一展示、恢复目标、浏览器标签和历史引用中的 display id；操作过程中可临时固定身份。晚到的目录事件不能覆盖较新的路径。集合缺失、身份冲突、视图缺失或不支持的版本显示不可用状态，保留原展示身份；旧路径被其他集合占用时不能直接打开替代文件。

## 接口和实现入口

后端统一命令为 `list_collections`、`resolve_collection`、`mutate_collection`、`set_collection_display_state` 和 `make_collection_identity_unique`。原表格和媒体库列表前端接口只是统一目录的类型投影。

CLI 与 MCP 共用只读操作 `collection.read`。CLI 示例：`flowix collection read --notebook <notebook-id> --id <collection-id>` 或 `flowix collection read --notebook <notebook-id> --path <notebook-relative-path>`；MCP 的 `memo` 工具使用结构化 action `collection.read`，参数为 `notebook` 加 `collectionId` 或 `path`。按路径读取只校验并读取指定文件；按 ID 读取优先查 SQLite 集合索引，索引缺失或结果失效时回退扫描文件。读取返回集合元数据和原始 payload；路径必须是笔记本内相对路径，ID 冲突和不支持的 schema 会报错。该简版不做视图筛选、分页或笔记 frontmatter 展开。

- 公共协议：`app/flowix-core/src/collection.rs`、`app/flowix-web/features/collection/model.ts`
- 索引和生命周期：`app/flowix-desktop/src/commands/collection.rs`
- 展示注册表：`app/flowix-web/lib/collection-display-registry.ts`
- 导航及事件：`app/flowix-web/features/workspace/use-cases/workspace-navigation.ts`、`collection-display-tracking.ts`

## ID 定位与定点更新

独立打开和编辑器嵌入引用均通过 `notebookId + collectionId` 解析唯一集合；`relativePath` 是可选缓存，不是加载或身份校验的依据。嵌入表格与媒体库使用集合 display 注册表，引用挂载期间固定展示身份；同一集合的其他引用通过集合事件同步最新名称和路径，不需要批量修改笔记正文。

改名只发布定点 `collection-changed`，不发布会导致全列表重载的 `file-management-changed`。已加载的视图分组与文件树更新对应行和路径缓存，媒体资源和表格业务结构未改变时保留对象引用、分页及滚动位置；文件监视中对应的改名通知不重复读取目录。集合展示跟踪只 resolve 受影响的 ID，不重查整份集合目录。集合导航经过保存屏障，默认激活已打开的同一集合视图；冲突重试必须校验基准集合 ID。

### 首次改名的业务对象复用

后端使用 `serde_json::Value` 承载业务载荷，首次序列化可能改变对象键的排列。前端使用共享语义比较（对象键顺序无关、数组顺序相关）复用未变的业务对象，不通过 `JSON.stringify` 字符串判断变化。表格加载、改名回包和事件同步采用相同的路径及默认值归一化，避免首次改名因序列化形态变化而替换列表依赖。名称、revision 和更新时间仍采用后端结果，真实业务变化正常更新。
