import type { SiteProfile } from './index';

/**
 * 115 web login, verified against OpenList's 115 driver (drivers/115/util.go)
 * and community reverse engineering of the 2026 login worker. 115 rotates its
 * endpoints (webapi → passportapi → qrcodeapi), so keep every URL here.
 */
export const profile115: SiteProfile = {
  domain: '115.com',
  // 2024-12 added KID; 2026 requires USERSESSIONID (the old SE field is gone).
  loginKeys: ['UID', 'CID', 'SEID', 'KID', 'USERSESSIONID'],
  // Read-only user info; 115's nav endpoint answers state:false when the
  // session is dead. Never use passportapi …/check/sso here: it logs out
  // other devices.
  healthCheck: {
    url: 'https://my.115.com/?ct=ajax&ac=nav',
    referrer: 'https://www.115.com/',
  },
  // 115 rejects cookie+UA combinations that do not match (OpenList #2502).
  uaSensitive: true,
  // The same web-device QR flow the 115 login page runs. Any new web login
  // replaces the previous web session, exactly like logging in manually.
  qrLogin: {
    tokenUrl: 'https://qrcodeapi.115.com/api/1.0/web/1.0/token',
    statusUrl: 'https://qrcodeapi.115.com/get/status/',
    loginUrl: 'https://passportapi.115.com/app/1.0/web/1.0/login/qrcode',
    app: 'web',
  },
};
