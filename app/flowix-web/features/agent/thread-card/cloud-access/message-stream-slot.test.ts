// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachToMessageStream,
  hideEmptyState,
  observeMessageStream,
} from './message-stream-slot';

function createStream() {
  const body = document.createElement('div');
  const list = document.createElement('div');
  list.className = 'agent-thread-card__messages';
  const indicator = document.createElement('div');
  indicator.className = 'agent-thread-card__loading-indicator';
  body.append(list, indicator);
  document.body.append(body);
  return { body, list, indicator };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('attachToMessageStream', () => {
  it('sits the notice directly above the thinking row', () => {
    const { body, list, indicator } = createStream();
    const card = document.createElement('div');
    attachToMessageStream(card, body);
    expect(Array.from(body.children)).toEqual([list, card, indicator]);
  });

  it('stays below the list when the renderer re-inserts it', () => {
    const { body, list, indicator } = createStream();
    const card = document.createElement('div');
    attachToMessageStream(card, body);
    // The message renderer mounts a fresh list right before the thinking row.
    const nextList = document.createElement('div');
    nextList.className = 'agent-thread-card__messages';
    list.remove();
    body.insertBefore(nextList, indicator);
    attachToMessageStream(card, body);
    expect(Array.from(body.children)).toEqual([nextList, card, indicator]);
  });

  it('falls back to the end when the stream has no thinking row', () => {
    const body = document.createElement('div');
    const card = document.createElement('div');
    attachToMessageStream(card, body);
    expect(body.lastElementChild).toBe(card);
  });

  it('never joins the welcome block of an empty conversation', () => {
    const body = document.createElement('div');
    const empty = document.createElement('div');
    empty.className = 'agent-thread-card__empty agent-thread-card__empty--expanded';
    const welcome = document.createElement('div');
    welcome.className = 'agent-thread-card__empty-welcome';
    empty.append(welcome);
    const indicator = document.createElement('div');
    indicator.className = 'agent-thread-card__loading-indicator';
    body.append(empty, indicator);

    const card = document.createElement('div');
    attachToMessageStream(card, body);
    // The notice is the turn's reply, so it is a stream row of its own — never
    // a decoration inside the greeting block.
    expect(Array.from(body.children)).toEqual([empty, card, indicator]);
    expect(card.parentElement).toBe(body);
  });
});

describe('hideEmptyState', () => {
  it('hides the welcome block while the notice is message state', () => {
    const body = document.createElement('div');
    const empty = document.createElement('div');
    empty.className = 'agent-thread-card__empty agent-thread-card__empty--expanded';
    body.append(empty);

    hideEmptyState(body, true);
    expect(empty.hasAttribute('hidden')).toBe(true);

    hideEmptyState(body, false);
    expect(empty.hasAttribute('hidden')).toBe(false);
  });

  it('tolerates a stream without a welcome block', () => {
    const body = document.createElement('div');
    expect(() => hideEmptyState(body, true)).not.toThrow();
    expect(() => hideEmptyState(null, true)).not.toThrow();
  });
});

describe('observeMessageStream', () => {
  it('follows the stream while mounted and stops after disposal', async () => {
    const { body, list, indicator } = createStream();
    const card = document.createElement('div');
    const dispose = observeMessageStream(card, body);
    expect(Array.from(body.children)).toEqual([list, card, indicator]);

    // A structural render mounts a new list; the notice must not stay above it.
    const nextList = document.createElement('div');
    nextList.className = 'agent-thread-card__messages';
    list.remove();
    body.insertBefore(nextList, indicator);
    await Promise.resolve();
    expect(Array.from(body.children)).toEqual([nextList, card, indicator]);

    card.remove();
    await Promise.resolve();
    expect(body.contains(card)).toBe(true);

    dispose();
    card.remove();
    await Promise.resolve();
    expect(body.contains(card)).toBe(false);
  });
});
