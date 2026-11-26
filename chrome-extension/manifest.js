import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('../package.json', 'utf8'));
const google = JSON.parse(fs.readFileSync('./google-config.json', 'utf8'));

const isFirefox = process.env.__FIREFOX__ === 'true';
const isWebStore = process.env.__WEBSTORE__ === 'true';

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
    // The public key keeps the extension ID stable for sideloaded installs;
    // Chrome Web Store forbids `key` and manages signing automatically.
    ...(!isWebStore ? { key: google.publicKey } : {}),
    default_locale: 'zh_CN',
    /**
     * if you want to support multiple languages, you can use the following reference
     * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Internationalization
     */
    name: '__MSG_extensionName__',
    version: packageJson.version,
    description: '__MSG_extensionDescription__',
    permissions: ['cookies', 'activeTab', 'tabs', 'storage', 'alarms', 'downloads', 'idle', 'scripting'].concat(
      sidePanelConfig.permissions,
    ),
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
    commands: {
      'push-current-site': {
        suggested_key: { default: 'Alt+Shift+U' },
        description: '推送当前网站到云端',
      },
      'pull-current-site': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: '从云端拉取当前网站',
      },
    },
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
