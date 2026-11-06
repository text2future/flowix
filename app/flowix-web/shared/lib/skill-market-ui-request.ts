import type { MarketUiView } from './market-ui-url';

export const SKILL_MARKET_UI_REQUEST_EVENT = 'flowix:open-skill-market-ui';

export interface SkillMarketUiRequest {
  view: MarketUiView;
  index: 0 | 1;
}

export function requestSkillMarketUi(view: MarketUiView, index: 0 | 1 = 0): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<SkillMarketUiRequest>(SKILL_MARKET_UI_REQUEST_EVENT, {
    detail: { view, index },
  }));
}
