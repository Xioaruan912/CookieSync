import type { SiteProfile } from './index';

/**
 * Baidu Netdisk (pan.baidu.com) web login guard.
 * Uses the read-only loginStatus endpoint to verify live server-side sessions,
 * protects core BDUSS / STOKEN cookies from incomplete overwrites, and pauses
 * idle background tabs on standby PCs.
 */
export const profileBaiduPan: SiteProfile = {
  domain: 'pan.baidu.com',
  loginKeys: ['BDUSS', 'STOKEN'],
  healthCheck: {
    url: 'https://pan.baidu.com/api/loginStatus?clienttype=0&app_id=250528&web=1',
    referrer: 'https://pan.baidu.com/',
    parse: (data, status) => {
      const errno = data.errno;
      const loginInfo = data.login_info as { username?: unknown; uk?: unknown } | null | undefined;
      if (status >= 200 && status < 300 && errno === 0 && loginInfo && (loginInfo.username || loginInfo.uk)) {
        return {
          state: 'ok',
          userName: loginInfo.username ? String(loginInfo.username) : String(loginInfo.uk),
        };
      }
      if (errno === -6 || (errno === 0 && !loginInfo)) {
        return { state: 'invalid', message: '百度网盘报告未登录或会话已失效' };
      }
      return {
        state: 'unknown',
        message: status >= 200 && status < 300 ? `百度网盘返回未知状态码（errno=${String(errno ?? '')}）` : `验证请求返回 HTTP ${status}`,
      };
    },
  },
  uaSensitive: false,
  singleSession: true,
  fastSync: true,
  loginPageUrl: 'https://pan.baidu.com/',
};
