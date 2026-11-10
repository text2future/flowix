/**
 * 账户注销与数据导出的文案分片。
 *
 * 主表 `messages.*` 行数冻结，这里的文案只服务于偏好设置里的「账户」区块
 * 与登录后的恢复提示，新增文案不再撑大主表。
 */
const zhCN = {
  "preferences.cloud.export": "导出数据",
  "preferences.cloud.exporting": "正在打包…",
  "preferences.cloud.exportSuccess": "数据已导出",
  "preferences.cloud.exportFailed": "导出失败，请稍后重试",
  "preferences.cloud.exportDialogTitle": "导出账户数据",
  "preferences.cloud.restored": "账户已恢复，欢迎回来",

  "preferences.cloud.deletion.title": "删除账号",
  "preferences.cloud.deletion.intro":
    "删除后立即退出登录，云端数据会在 {days} 天后彻底清除。在此之前重新登录可以恢复账户。",
  "preferences.cloud.deletion.deadline": "可恢复截止：{date}",
  "preferences.cloud.deletion.localNote":
    "本地笔记文件不会被删除，但会与云端解除同步关联；重新注册同一邮箱不会把旧数据重新上传。",
  "preferences.cloud.deletion.emailLabel": "输入账号邮箱 {email} 以确认",
  "preferences.cloud.deletion.emailPlaceholder": "账号邮箱",
  "preferences.cloud.deletion.mismatch": "邮箱不一致，请重新输入",
  "preferences.cloud.deletion.confirm": "删除账号",
  "preferences.cloud.deletion.deleting": "正在删除…",
  "preferences.cloud.deletion.done": "账号已删除，{date} 前登录可恢复",
  "preferences.cloud.deletion.doneNoDeadline": "账号已删除",
  "preferences.cloud.deletion.pendingCancellations":
    "以下订阅未能在支付平台取消，请手动处理：{ids}",
  "preferences.cloud.deletion.exportFirst": "先导出我的数据",
  "preferences.cloud.deletion.loadFailed": "读取账户状态失败，请稍后重试",
};

export default zhCN;
