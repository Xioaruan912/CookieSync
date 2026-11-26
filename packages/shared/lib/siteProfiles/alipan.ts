import type { SiteProfile } from './index';

/**
 * Alipan (alipan.com) web login guard.
 * Protects core cookies and pauses idle background tabs on standby PCs.
 */
export const profileAlipan: SiteProfile = {
  domain: 'alipan.com',
  loginKeys: ['cna', 'isg'],
  uaSensitive: false,
  singleSession: true,
  fastSync: true,
  loginPageUrl: 'https://www.alipan.com/sign/in',
};
