import { memoRepository } from '@features/memo/services/memo-repository';

export const BLANK_NOTEBOOK_TEMPLATE_ID = 'blank';

export type NotebookTemplateDocumentKind = 'guide' | 'example';

export interface NotebookTemplateDocument {
  title: string;
  kind: NotebookTemplateDocumentKind;
  content: string;
}

export interface NotebookTemplate {
  id: string;
  name: string;
  description: string;
  documents: readonly NotebookTemplateDocument[];
}

export const NOTEBOOK_TEMPLATES: readonly NotebookTemplate[] = [
  {
    id: BLANK_NOTEBOOK_TEMPLATE_ID,
    name: '空白笔记本',
    description: '从一个干净的笔记本开始，自由组织内容。',
    documents: [],
  },
  {
    id: 'project-development',
    name: '项目开发',
    description: '从需求、方案到开发记录，建立一套轻量的项目工作区。',
    documents: [
      {
        title: '项目开始这里',
        kind: 'guide',
        content: `# 项目开始这里

这是项目开发笔记本的入口文档。

## 建议从这里开始

- 写下项目目标和预期结果
- 补充项目背景、范围与负责人
- 在后续文档中记录需求、方案和进度

## 项目概览

- 项目目标：
- 当前阶段：
- 关键参与者：
- 相关资料：
`,
      },
      {
        title: '开发工作流',
        kind: 'guide',
        content: `# 开发工作流

一套可按团队习惯调整的基础流程。

1. 明确问题与需求
2. 拆解任务并确认验收标准
3. 设计技术方案
4. 开发、验证与发布
5. 记录复盘与后续行动

## 工作约定

- 分支策略：
- 提交规范：
- 发布方式：
- 需要持续关注的问题：
`,
      },
      {
        title: '案例：需求拆解',
        kind: 'example',
        content: `# 案例：需求拆解

## 背景

用户希望更快找到最近使用的项目文档。

## 目标

- 降低查找入口
- 保留最近使用的上下文

## 任务拆解

- [ ] 梳理现有文档入口
- [ ] 设计最近使用列表
- [ ] 增加空状态和加载状态
- [ ] 验证不同规模项目下的表现

## 验收标准

- 用户可以在一个入口看到最近文档
- 列表内容与实际打开记录保持一致
`,
      },
      {
        title: '案例：技术方案',
        kind: 'example',
        content: `# 案例：技术方案

## 方案摘要

用本页记录一个方案的关键决策，方便实现和评审时回看。

## 背景与约束

- 当前问题：
- 技术约束：
- 时间约束：

## 方案

- 方案 A：
- 方案 B：
- 最终选择：

## 风险与后续

- 风险：
- 验证方式：
- 后续行动：
`,
      },
    ],
  },
  {
    id: 'fitness-plan',
    name: '健身安排',
    description: '记录训练计划、身体状态和每周复盘，让行动更容易坚持。',
    documents: [
      {
        title: '健身笔记本使用说明',
        kind: 'guide',
        content: `# 健身笔记本使用说明

建议把训练计划、训练记录和阶段复盘分别记录下来。

## 每次训练记录

- 日期：
- 训练部位：
- 精力状态：
- 完成情况：
- 备注：

请根据自身情况安排训练，并在需要时咨询专业人士。
`,
      },
      {
        title: '每周训练计划',
        kind: 'guide',
        content: `# 每周训练计划

## 本周目标

- 训练次数：
- 重点部位：
- 恢复安排：

## 计划

- 周一：
- 周二：
- 周三：
- 周四：
- 周五：
- 周六：
- 周日：
`,
      },
      {
        title: '案例：一周训练安排',
        kind: 'example',
        content: `# 案例：一周训练安排

这是一个用于参考的基础安排，请按个人情况调整。

- 周一：下肢力量
- 周二：轻度有氧与拉伸
- 周三：上肢力量
- 周四：休息或散步
- 周五：全身训练
- 周末：户外活动与恢复

## 本周复盘

- 做得好的地方：
- 需要调整的地方：
`,
      },
      {
        title: '案例：训练记录',
        kind: 'example',
        content: `# 案例：训练记录

## 今日状态

- 睡眠：
- 精力：
- 不适或疼痛：

## 训练内容

| 动作 | 组数 | 次数 | 重量 | 备注 |
| --- | ---: | ---: | ---: | --- |
| 深蹲 |  |  |  |  |
| 推举 |  |  |  |  |
| 划船 |  |  |  |  |
`,
      },
    ],
  },
  {
    id: 'course-design',
    name: '课程设计',
    description: '从课程目标到课次安排，集中沉淀教学设计与课堂案例。',
    documents: [
      {
        title: '课程设计从这里开始',
        kind: 'guide',
        content: `# 课程设计从这里开始

先定义学习者、学习目标和最终产出，再安排课程内容。

## 课程概览

- 课程名称：
- 目标学习者：
- 先修知识：
- 课程目标：
- 课程产出：
`,
      },
      {
        title: '课程结构与备课流程',
        kind: 'guide',
        content: `# 课程结构与备课流程

1. 定义学习目标
2. 组织知识结构
3. 设计练习与反馈
4. 准备课堂材料
5. 课后复盘并调整

## 课次安排

| 课次 | 主题 | 目标 | 练习 | 材料 |
| --- | --- | --- | --- | --- |
| 1 |  |  |  |  |
| 2 |  |  |  |  |
| 3 |  |  |  |  |
`,
      },
      {
        title: '案例：课程大纲',
        kind: 'example',
        content: `# 案例：课程大纲

## 主题

用一个真实问题串联概念、练习和最终作品。

## 学习目标

- 能解释核心概念
- 能完成一次独立实践
- 能根据反馈修改作品

## 课程模块

- 模块一：建立基础认知
- 模块二：拆解案例
- 模块三：完成练习
- 模块四：展示与复盘
`,
      },
      {
        title: '案例：备课清单',
        kind: 'example',
        content: `# 案例：备课清单

- [ ] 明确本节课的一个核心目标
- [ ] 准备开场问题
- [ ] 准备示例或演示材料
- [ ] 设计课堂练习
- [ ] 准备反馈问题
- [ ] 记录课后观察
`,
      },
    ],
  },
] as const;

export function getNotebookTemplate(templateId: string): NotebookTemplate {
  return NOTEBOOK_TEMPLATES.find((template) => template.id === templateId)
    ?? NOTEBOOK_TEMPLATES[0];
}

function normalizedRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export async function initializeNotebookTemplate(notebookId: string, templateId: string): Promise<void> {
  const template = getNotebookTemplate(templateId);
  if (template.documents.length === 0) return;

  const existing = await memoRepository.list({ notebookId, limit: 200 });
  const existingPaths = new Set(existing.memos.map((memo) => normalizedRelativePath(
    memo.relativePath ?? memo.filename,
  )));

  for (const document of template.documents) {
    const expectedPath = normalizedRelativePath(`${document.title}.md`);
    if (existingPaths.has(expectedPath)) continue;
    await memoRepository.createWithContent(document.title, document.content, notebookId);
    existingPaths.add(expectedPath);
  }
}
