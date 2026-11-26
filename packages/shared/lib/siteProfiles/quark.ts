import type { SiteProfile } from './index';

/**
 * Quark Cloud Drive (pan.quark.cn) web login guard.
 * Uses the read-only account/info endpoint to verify live server-side sessions,
 * protects core login cookies from incomplete overwrites, and pauses idle
 * background tabs on standby PCs to reduce multi-device session kicks.
 */
export const profileQuark: SiteProfile = {
  domain: 'pan.quark.cn',
  loginKeys: ['__pus', '__kp', '__kps'],
  healthCheck: {
    url: 'https://pan.quark.cn/account/info?fr=pc&platform=pc',
    referrer: 'https://pan.quark.cn/',
    parse: (data, status) => {
      const payload = data.data as { nickname?: unknown; avatarUri?: unknown } | null | undefined;
      if (status >= 200 && status < 300 && data.success === true && payload && typeof payload === 'object') {
        return {
          state: 'ok',
          userName: payload.nickname ? String(payload.nickname) : undefined,
        };
      }
      if (
        (data.success === true && payload === null) ||
        status === 401 ||
        (data.success === false && /login|auth|401|expired/i.test(String(data.code || data.message || '')))
      ) {
        return {
          state: 'invalid',
          message: (typeof data.message === 'string' && data.message) || '夸克网盘报告未登录或会话已失效',
        };
      }
      return {
        state: 'unknown',
        message: status >= 200 && status < 300 ? '夸克网盘验证响应缺少登录状态字段' : `验证请求返回 HTTP ${status}`,
      };
    },
  },
  uaSensitive: true,
  singleSession: true,
  fastSync: true,
  loginPageUrl: 'https://pan.quark.cn/',
};
