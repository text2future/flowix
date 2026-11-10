// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { I18nKey } from '@/lib/i18n';
import { createCloudAccessCard } from './cloud-access-card';

const LABELS: Record<string, string> = {
  'agent.cloudAccess.signedOut.title': '请登录后使用云模型',
  'agent.cloudAccess.signedOut.description': '官方提供，在输入框切换不同模型',
  'agent.cloudAccess.signedOut.action': '登录',
  'agent.cloudAccess.noCredits.title': '账号点数不足',
  'agent.cloudAccess.noCredits.description': '升级 AI 套餐，让灵感创作不中断',
  'agent.cloudAccess.noCredits.action': '升级',
};

const t = ((key: I18nKey) => LABELS[key] ?? key) as (key: I18nKey) => string;

function mount() {
  const onSignIn = vi.fn();
  const onBuyCredits = vi.fn();
  const card = createCloudAccessCard({ t, onSignIn, onBuyCredits });
  document.body.append(card.el);
  return { card, onSignIn, onBuyCredits };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('createCloudAccessCard', () => {
  it('stays hidden until a state is rendered', () => {
    const { card } = mount();
    expect(card.el.hidden).toBe(true);
    expect(card.el.querySelector('.agent-cloud-access__title')?.textContent).toBe('');
  });

  it('offers sign-in for a signed-out account', () => {
    const { card, onSignIn, onBuyCredits } = mount();
    card.render('signed_out');
    expect(card.el.hidden).toBe(false);
    expect(card.el.dataset.kind).toBe('signed_out');
    expect(card.el.querySelector('.agent-cloud-access__title')?.textContent)
      .toBe('请登录后使用云模型');
    expect(card.el.querySelector('.agent-cloud-access__description')?.textContent)
      .toBe('官方提供，在输入框切换不同模型');
    card.el.querySelector<HTMLButtonElement>('.agent-cloud-access__action')!.click();
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(onBuyCredits).not.toHaveBeenCalled();
  });

  it('offers the credit purchase for an exhausted balance', () => {
    const { card, onSignIn, onBuyCredits } = mount();
    card.render('no_credits');
    expect(card.el.querySelector('.agent-cloud-access__title')?.textContent).toBe('账号点数不足');
    expect(card.el.querySelector('.agent-cloud-access__description')?.textContent)
      .toBe('升级 AI 套餐，让灵感创作不中断');
    expect(card.el.querySelector('.agent-cloud-access__action')?.textContent).toBe('升级');
    card.el.querySelector<HTMLButtonElement>('.agent-cloud-access__action')!.click();
    expect(onBuyCredits).toHaveBeenCalledOnce();
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('offers no close control: the card leaves on its own', () => {
    const { card } = mount();
    card.render('no_credits');
    expect(card.el.querySelector('.agent-cloud-access__dismiss')).toBeNull();
  });

  it('hides again when the state clears', () => {
    const { card } = mount();
    card.render('signed_out');
    card.render(null);
    expect(card.el.hidden).toBe(true);
    expect(card.el.dataset.kind).toBeUndefined();
  });

  it('does not let a click bubble into the composer', () => {
    const onSignIn = vi.fn();
    const card = createCloudAccessCard({ t, onSignIn, onBuyCredits: vi.fn() });
    const bubble = vi.fn();
    document.body.addEventListener('pointerdown', bubble);
    card.render('signed_out');
    card.el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(bubble).not.toHaveBeenCalled();
    document.body.removeEventListener('pointerdown', bubble);
  });
});
