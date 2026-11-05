import { describe, expect, it } from 'vitest';

import { resolveActiveConversationInstanceId } from './active-conversation-api';

describe('active agent conversation resolution', () => {
  it('always follows the main column, even while the side column holds another conversation', () => {
    expect(resolveActiveConversationInstanceId({
      mainInstanceId: 'conversation-main',
      sideInstanceId: 'conversation-side',
      sideVisible: true,
    })).toBe('conversation-main');
  });

  it('falls back to the side column only while it is on screen and the main column is empty', () => {
    expect(resolveActiveConversationInstanceId({
      mainInstanceId: null,
      sideInstanceId: 'conversation-side',
      sideVisible: true,
    })).toBe('conversation-side');

    expect(resolveActiveConversationInstanceId({
      mainInstanceId: null,
      sideInstanceId: 'conversation-side',
      sideVisible: false,
    })).toBeNull();
  });

  it('reports nothing when neither column shows a conversation', () => {
    expect(resolveActiveConversationInstanceId({
      mainInstanceId: null, sideInstanceId: null, sideVisible: true,
    })).toBeNull();
  });
});
