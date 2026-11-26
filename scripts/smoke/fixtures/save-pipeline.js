// 冒烟 2：文档保存链路的三个不变量。
//
// 启动路径要动（2.1 入口瘦身）时最先可能被破坏的就是这里，但它在 jsdom 单测里
// 感受不到真实定时器/事件循环。这里用真实浏览器跑：
//   1. latest-value 槽位：同 lane 的待执行任务被替换，不会形成无界队列
//   2. 单写者：同一文档任何时刻只有一个任务在执行
//   3. capture 时钟：300ms 去抖 + cancel 不再触发

import { checkAsync, assert, assertEqual, installCrashGuard, report, sleep } from './harness.js';

installCrashGuard();

const {
  enqueueDocumentCommit,
  waitForDocumentCommits,
  scheduleDocumentCapture,
  cancelDocumentCapture,
  DOCUMENT_SAVE_DELAY_MS,
} = await import('@features/document/store/document-commit-queue');

await checkAsync('single writer: jobs for one document never overlap', async () => {
  const key = 'md:smoke-single-writer';
  let running = 0;
  let maxConcurrent = 0;
  const run = () => async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await sleep(5);
    running -= 1;
    return true;
  };
  const first = enqueueDocumentCommit(key, 'body', run());
  const second = enqueueDocumentCommit(key, 'title', run());
  await Promise.all([first, second]);
  await waitForDocumentCommits(key);
  assertEqual(maxConcurrent, 1, '同一文档出现了并发写者');
});

await checkAsync('latest-value slot: a superseded job resolves but never runs', async () => {
  const key = 'md:smoke-supersede';
  let blockerDone = false;
  const order = [];

  // body lane 先占住执行权
  const blocker = enqueueDocumentCommit(key, 'body', async () => {
    await sleep(20);
    blockerDone = true;
    return true;
  });
  // title lane 连排两次，第一次应被替换
  const superseded = enqueueDocumentCommit(key, 'title', async () => {
    order.push('superseded-ran');
    return true;
  });
  await sleep(1);
  const winner = enqueueDocumentCommit(key, 'title', async () => {
    order.push('winner-ran');
    return true;
  });

  await blocker;
  const supersededResult = await superseded;
  await winner;
  await waitForDocumentCommits(key);

  assert(blockerDone, '占位任务未完成，测试时序不成立');
  assertEqual(supersededResult, true, '被替换的任务应当直接以 true 结算（调用方随后会复检）');
  assertEqual(order.join(','), 'winner-ran', '被替换的任务不应真正执行');
});

await checkAsync('capture clock: debounce coalesces bursts into one run', async () => {
  const key = 'md:smoke-capture-debounce';
  let runs = 0;
  scheduleDocumentCapture(key, () => { runs += 1; });
  scheduleDocumentCapture(key, () => { runs += 1; });
  scheduleDocumentCapture(key, () => { runs += 1; });
  await sleep(DOCUMENT_SAVE_DELAY_MS + 80);
  assertEqual(runs, 1, '连续输入应合并为一次 capture');
});

await checkAsync('capture clock: cancel prevents the run', async () => {
  const cancelKey = 'md:smoke-capture-cancel';
  let cancelled = 0;
  scheduleDocumentCapture(cancelKey, () => { cancelled += 1; });
  cancelDocumentCapture(cancelKey);
  await sleep(DOCUMENT_SAVE_DELAY_MS + 80);
  assertEqual(cancelled, 0, 'cancel 之后不应再触发 capture');
});

report({ case: 'save-pipeline' });
