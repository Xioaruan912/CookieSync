import type { SiteProfile } from './index';

/**
 * Xiaohongshu has no stable read-only "am I logged in" endpoint: its web APIs
 * require per-request signatures, so a network probe would fail for reasons
 * unrelated to the session. The profile therefore only checks the local cookie
 * set, which is honest about what it can know.
 */
export const profileXiaohongshu: SiteProfile = {
  domain: 'xiaohongshu.com',
  loginKeys: ['web_session'],
  fastSync: true,
};
