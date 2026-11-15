/**
 * 分片上传的外部入口。surface（HTML 预览里产出的文件）与编辑器附件走同一套
 * 分片协议，缺 public 入口时调用方只能深引 attachments 内部实现。
 */
export { uploadInChunks } from '../extensions/attachment-link/upload/chunked';
