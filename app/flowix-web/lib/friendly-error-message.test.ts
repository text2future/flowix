import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { friendlyErrorMessage } from './friendly-error-message';
import { cloudModelAccessErrorMessage, cloudSyncErrorMessage } from '@platform/tauri/errors';
import { getMessages, type I18nKey } from './i18n';

// Read the merged table so sharded messages are covered too.
const t = (key: I18nKey) => getMessages('zh-CN')[key];
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('friendly error presentation', () => {
  it('keeps internal errors in diagnostics and uses contextual copy', () => {
    const error = new Error('cloud API error 500 INTERNAL_ERROR: SQL failed (request id: test-ref)');
    const message = friendlyErrorMessage(error, t, 'errors.friendly.ordersLoad');
    expect(message).toBe('无法读取订单，请稍后重试');
    expect(message).not.toMatch(/SQL|INTERNAL_ERROR|test-ref|500/);
    // 诊断信息走结构化 context（logger 的约定），因此从第二个参数里取；
    // 断言"原始错误与 fallback key 都留在了日志里"，而不是固定字符串形状。
    const calls = vi.mocked(console.warn).mock.calls;
    const [label, context] = calls[calls.length - 1] ?? [];
    expect(String(label)).toContain('friendly message fallback');
    expect(context).toMatchObject({ fallback: 'errors.friendly.ordersLoad', error });
  });

  it.each([
    [new Error('error sending request for url (https://staging-cloud.flowix.cc)'), '无法连接服务，请检查网络后重试'],
    [{ code: 'ETIMEDOUT', message: 'socket failure' }, '等待时间较长，请稍后重试'],
    ['cloud API error 429 RATE_LIMITED: too many requests', '操作较频繁，请稍后重试'],
  ])('translates transport errors without showing service details', (error, expected) => {
    expect(friendlyErrorMessage(error, t, 'errors.friendly.ordersLoad')).toBe(expected);
  });

  it('distinguishes bad credentials from an expired session', () => {
    expect(cloudSyncErrorMessage('cloud API error 401 INVALID_CREDENTIALS: wrong password', t))
      .toBe('邮箱或密码不正确，请检查后重试');
    expect(cloudSyncErrorMessage('cloud API error 401 INVALID_REFRESH_TOKEN: expired', t))
      .toBe('登录已过期，请重新登录');
  });

  it('preserves known membership guidance without exposing request IDs', () => {
    expect(cloudSyncErrorMessage('cloud API error 403 STORAGE_PLAN_REQUIRED: no plan', t))
      .toBe('云会员未开通或已过期，请开通或续费后重试');
    expect(cloudModelAccessErrorMessage('cloud API error 403 MEMBERSHIP_REQUIRED: inactive (request id: test-ref)', t))
      .not.toContain('test-ref');
    expect(cloudModelAccessErrorMessage('cloud API error 503 INTERNAL_ERROR: provider failure', t, 'errors.friendly.cloudConnect'))
      .toBe('无法连接云模型，请稍后重试');
  });

  it('keeps friendly Chinese copy free of trailing full stops', () => {
    for (const [key, message] of Object.entries(getMessages('zh-CN'))) {
      if (key.startsWith('errors.friendly.')) expect(message).not.toMatch(/[。.]$/);
    }
  });
});
