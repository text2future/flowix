import { describe, expect, it } from 'vitest';
import {
  deriveCloudAccess,
  isCloudModelProvider,
  resolveCloudAccessKind,
  signedOutAccessFor,
} from './cloud-access';

const cloudProvider = 'flowix-cloud-member';
const previewProvider = '__flowix-cloud-preview';

describe('isCloudModelProvider', () => {
  it('recognises Cloud providers and the signed-out preview entry', () => {
    expect(isCloudModelProvider(cloudProvider)).toBe(true);
    expect(isCloudModelProvider('Flowix-Cloud')).toBe(true);
    expect(isCloudModelProvider(previewProvider)).toBe(true);
    expect(isCloudModelProvider('custom-provider')).toBe(false);
    expect(isCloudModelProvider(undefined)).toBe(false);
  });
});

describe('resolveCloudAccessKind', () => {
  it('ignores failures from user-owned providers', () => {
    expect(resolveCloudAccessKind({
      providerId: 'deepseek',
      authenticated: true,
      category: 'quota_exhausted',
      message: 'Insufficient Balance',
    })).toBeNull();
  });

  it('maps any Cloud failure to signed_out when there is no session', () => {
    expect(resolveCloudAccessKind({
      providerId: previewProvider,
      authenticated: false,
      message: 'unknown provider',
    })).toBe('signed_out');
  });

  it('maps exhausted credit failures to no_credits', () => {
    expect(resolveCloudAccessKind({
      providerId: cloudProvider,
      authenticated: true,
      category: 'quota_exhausted',
    })).toBe('no_credits');
    expect(resolveCloudAccessKind({
      providerId: cloudProvider,
      authenticated: true,
      message: '402: {"code":"INSUFFICIENT_CREDITS"}',
    })).toBe('no_credits');
    expect(resolveCloudAccessKind({
      providerId: cloudProvider,
      authenticated: true,
      message: '余额不足，请充值',
    })).toBe('no_credits');
  });

  it('maps expired credentials to signed_out', () => {
    expect(resolveCloudAccessKind({
      providerId: cloudProvider,
      authenticated: true,
      category: 'authentication',
    })).toBe('signed_out');
    expect(resolveCloudAccessKind({
      providerId: cloudProvider,
      authenticated: true,
      message: '401 Unauthorized',
    })).toBe('signed_out');
  });

  it('leaves unrelated Cloud failures alone', () => {
    expect(resolveCloudAccessKind({
      providerId: cloudProvider,
      authenticated: true,
      category: 'rate_limited',
      message: '429 Too Many Requests',
    })).toBeNull();
  });
});

describe('signedOutAccessFor', () => {
  it('blocks only Cloud models while signed out', () => {
    expect(signedOutAccessFor(cloudProvider, false)).toBe('signed_out');
    expect(signedOutAccessFor(previewProvider, false)).toBe('signed_out');
    expect(signedOutAccessFor('custom', false)).toBeNull();
    expect(signedOutAccessFor(cloudProvider, true)).toBeNull();
  });
});

describe('deriveCloudAccess', () => {
  const context = { providerId: cloudProvider, authenticated: true };

  it('reads the newest failed assistant row', () => {
    expect(deriveCloudAccess([
      { id: 'u1', role: 'user', content: 'hi' },
      { id: 'a0', role: 'assistant', content: 'ok' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'failed',
        errorDetails: { category: 'quota_exhausted' },
      },
    ], context)).toEqual({ messageId: 'a1', kind: 'no_credits' });
  });

  it('stops at the newest failure so an older credit error cannot resurface', () => {
    expect(deriveCloudAccess([
      {
        id: 'a1',
        role: 'assistant',
        content: 'old',
        errorDetails: { category: 'quota_exhausted' },
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'model missing',
        errorDetails: { category: 'model_not_found' },
      },
    ], context)).toBeNull();
  });

  it('prefers the upstream provider message over the wrapper text', () => {
    expect(deriveCloudAccess([
      {
        id: 'a1',
        role: 'assistant',
        content: 'Pi exited with status 1',
        errorDetails: {
          category: 'authentication',
          upstreamMessage: 'insufficient credits',
        },
      },
    ], context)).toEqual({ messageId: 'a1', kind: 'no_credits' });
  });

  it('returns null without a failed assistant row', () => {
    expect(deriveCloudAccess([{ id: 'u1', role: 'user', content: 'hi' }], context)).toBeNull();
  });
});
