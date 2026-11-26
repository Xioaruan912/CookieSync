import type { SiteProfile } from './index';

/**
 * Bilibili (bilibili.com) web login guard.
 * Uses the read-only web-interface/nav endpoint to verify live server-side
 * login status without triggering extra device kicks.
 */
export const profileBilibili: SiteProfile = {
  domain: 'bilibili.com',
  loginKeys: ['SESSDATA', 'bili_jct', 'DedeUserID'],
  healthCheck: {
    url: 'https://api.bilibili.com/x/web-interface/nav',
    referrer: 'https://www.bilibili.com/',
    parse: (data, status) => {
      const code = data.code;
      const payload = data.data as { isLogin?: unknown; uname?: unknown } | null | undefined;
      if (status >= 200 && status < 300 && code === 0 && payload?.isLogin === true) {
        return {
          state: 'ok',
          userName: payload.uname ? String(payload.uname) : undefined,
        };
      }
      if (code === -101 || payload?.isLogin === false) {
        return {
          state: 'invalid',
          message: (typeof data.message === 'string' && data.message) || '哔哩哔哩报告未登录或会话已失效',
        };
      }
      return {
        state: 'unknown',
        message: status >= 200 && status < 300 ? `哔哩哔哩返回未知状态码（code=${String(code ?? '')}）` : `验证请求返回 HTTP ${status}`,
      };
    },
  },
  uaSensitive: false,
  singleSession: false,
  fastSync: true,
  loginPageUrl: 'https://passport.bilibili.com/login',
};
