import type { SiteProfile } from './index';

/**
 * Quark Cloud Drive (pan.quark.cn) web login guard.
 * Protects core login cookies from incomplete overwrites and pauses idle
 * background tabs on standby PCs to reduce multi-device session kicks.
 */
export const profileQuark: SiteProfile = {
  domain: 'pan.quark.cn',
  loginKeys: ['__pus', '__kp', '__kps'],
  uaSensitive: true,
  singleSession: true,
  fastSync: true,
  loginPageUrl: 'https://pan.quark.cn/',
};
