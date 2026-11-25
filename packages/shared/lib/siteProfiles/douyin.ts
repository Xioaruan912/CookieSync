import type { SiteProfile } from './index';

/**
 * Douyin's web APIs need a per-request `a_bogus` signature, so there is no
 * reliable read-only login probe. Only the primary session cookie is verified
 * locally; the status card must say "未验证" rather than invent a network answer.
 */
export const profileDouyin: SiteProfile = {
  domain: 'douyin.com',
  loginKeys: ['sessionid'],
  fastSync: true,
};
