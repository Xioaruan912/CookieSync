import type { SiteProfile } from './index';

/**
 * China Telecom Cloud Drive (cloud.189.cn) web login guard.
 * Protects COOKIE_LOGIN_USER from incomplete overwrites and pauses idle
 * background tabs on standby PCs.
 */
export const profileCloud189: SiteProfile = {
  domain: 'cloud.189.cn',
  loginKeys: ['COOKIE_LOGIN_USER'],
  uaSensitive: false,
  singleSession: true,
  fastSync: true,
  loginPageUrl: 'https://cloud.189.cn/web/login.html',
};
