import type { SiteProfile } from './index';

/**
 * Baidu Netdisk (pan.baidu.com) web login guard.
 * Protects core BDUSS / STOKEN cookies from incomplete overwrites and pauses
 * idle background tabs on standby PCs.
 */
export const profileBaiduPan: SiteProfile = {
  domain: 'pan.baidu.com',
  loginKeys: ['BDUSS', 'STOKEN'],
  uaSensitive: false,
  singleSession: true,
  fastSync: true,
};
