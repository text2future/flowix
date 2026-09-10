# Flowix 声明式插件开发

Flowix 当前支持不执行任意插件代码的声明式插件。插件目录至少包含：

```text
my-plugin/
├── plugin.json
└── SKILL.md
```

`plugin.json` 使用 `schemaVersion: 2`。`kind: artifact-tool` 插件通过
标准输入接收最终产物，Flowix Host 负责校验、写入
`.flowix/plugin/<id>/`，并创建指针文档。第三方插件只需选择已有的
`format`、`parser` 和 `renderer`，无需修改宿主代码；未知组合会在安装前被拒绝。

示例见 [`examples/plain-report`](../examples/plain-report)，字段契约见
[`plugin-manifest-v2.schema.json`](./plugin-manifest-v2.schema.json)。

## 生命周期

1. 在设置页选择插件目录，Flowix 先读取名称、版本和声明的 Host 能力。
2. 校验通过后，插件原子地写入 `~/.flowix/plugin/<id>`；同 ID 的新版本走备份和回滚流程。
3. 停用只阻止新的 CLI/Agent 操作，已有产物仍由 Host 读取。
4. 卸载只删除插件安装目录，不删除笔记本中的产物和指针文档。

CLI 可用命令：

```text
flowix plugin list
flowix plugin describe <id>
flowix plugin create <id> --notebook <name|id|path>
```

直接调用 CLI 时，输入必须是最终内容：思维导图必须恰好一个一级标题，
其他产物必须符合对应 parser；不要传 Markdown code fence。Agent 输出由
Desktop 入口负责清理说明文字和 code fence 后再应用同一份产物协议。

Manifest 中的 `permissions` 是能力声明和安装前提示。当前声明式流程不会
把它当作授权记录，也不会因此启用任意代码执行；真正需要 Host 权限检查的
执行扩展应等受限 API 协议稳定后再设计。

## 验收

使用仓库外的示例目录验证：安装、发现、`list/describe/create`、停用、升级
失败回滚、卸载，以及卸载后打开旧产物。插件目录中的符号链接、路径越界、
未知 parser/renderer、版本不兼容和完整性哈希错误都应被诊断而不会阻断基础笔记功能。
