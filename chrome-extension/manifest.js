import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('../package.json', 'utf8'));
const google = JSON.parse(fs.readFileSync('./google-config.json', 'utf8'));
const googleClientId = (process.env.GOOGLE_CLIENT_ID || google.clientId || '').trim();
if (googleClientId && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(googleClientId))
  throw new Error('Invalid GOOGLE_CLIENT_ID');

const isFirefox = process.env.__FIREFOX__ === 'true';

const sidePanelConfig = {
  side_panel: {
    default_path: 'sidepanel/index.html',
  },
  permissions: !isFirefox ? ['sidePanel', 'contextMenus'] : [],
};

/**
 * After changing, please reload the extension at `chrome://extensions`
 * @type {chrome.runtime.ManifestV3}
 */
const manifest = Object.assign(
  {
    manifest_version: 3,
    key: google.publicKey,
    ...(googleClientId && {
      oauth2: { client_id: googleClientId, scopes: ['https://www.googleapis.com/auth/drive.appdata'] },
    }),
    default_locale: 'zh_CN',
    /**
     * if you want to support multiple languages, you can use the following reference
     * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Internationalization
     */
    name: 'CookieSync · 登录状态同步',
    version: packageJson.version,
    description: '通过 Google Drive、WebDAV、Cloudflare KV 或 GitHub Gist 同步 Cookie 与 LocalStorage。',
    permissions: ['cookies', 'activeTab', 'tabs', 'storage', 'identity', 'alarms'].concat(sidePanelConfig.permissions),
    host_permissions: ['<all_urls>'],
    options_page: 'options/index.html',
    background: {
      service_worker: 'background.iife.js',
      type: 'module',
    },
    action: {
      default_popup: 'popup/index.html',
      default_icon: 'icon-34.png',
    },
    // key: key,
    // chrome_url_overrides: {
    //   newtab: 'newtab/index.html',
    // },
    icons: {
      128: 'icon-128.png',
    },
    content_scripts: [
      {
        matches: ['*://*/*'],
        js: ['content/index.iife.js'],
        run_at: 'document_start',
      },
    ],
    // devtools_page: 'devtools/index.html',
    web_accessible_resources: [
      {
        resources: ['*.js', '*.css', '*.svg', 'icon-128.png', 'icon-34.png'],
        matches: ['*://*/*'],
      },
    ],
  },
  !isFirefox && { side_panel: { ...sidePanelConfig.side_panel } },
);

export default manifest;
