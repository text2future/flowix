/** 集合行的来源规则（显式链接 + 条件收集），以及按视图过滤/排序后的可见行。
 *  表格界面与嵌入页数据桥共用同一份，否则「同一个集合在界面有行、在工作台没有行」。 */
export { collectionConditionRecords, collectionDatasetRecords, collectionViewRecords } from '../collection-records';
export type { CollectionRecordOptions } from '../collection-records';
