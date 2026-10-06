# flowix-sync

`flowix-sync` 是 Flowix Cloud 的独立 Rust 同步模块，负责 Cloud API、会话、会员状态、笔记本映射、revision 与冲突处理。它不依赖 Tauri，也不直接展示系统 UI。

边界约定：

- macOS “通过 Apple 登录”系统面板由 `flowix-desktop/src/apple_sign_in.rs` 调用 `AuthenticationServices`。
- 本 crate 先获取 Cloud challenge，再交换 Apple Identity Token 与 Authorization Code。
- Apple 首次授权才返回姓名；后续请求会省略 `displayName`。
- Access Token 只驻留内存；轮换后的 Refresh Token 由桌面层持久化，不进入 Web IPC。
- 同步状态保存在独立 SQLite 中，并按 Cloud workspace 隔离 notebook link、cursor 与 note revision。
- Push 成功会把服务端返回的 revision/hash/syncSeq 与 inflight ACK 原子写入本地基线；各端共用 dirty + 磁盘 hash 判定，避免 watcher settle 窗口覆盖本地编辑。
- Blob reservation 同时兼容旧 Cloud 代理路径与短期直传 capability；直传请求不会携带 Flowix Bearer token，下载后仍按 SHA-256 校验。
- 当前协议按服务端提交顺序选择可见 head（last commit wins）。旧 revision 的本地提交被拒绝时，Markdown 先用 `diffy` 做三方合并；无法合并或缺少共同版本时，桌面端将未提交内容记入笔记本的路径版本历史，再采用云端 head。该历史保存在本机笔记本中；云端 revision 历史仍由 Cloud 保留。

验证：

```bash
cd app
cargo test -p flowix-sync
```
