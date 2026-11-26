import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('../package.json', 'utf8'));
const google = JSON.parse(fs.readFileSync('./google-config.json', 'utf8'));

const isFirefox = process.env.__FIREFOX__ === 'true';
// The `chrome` branch targets Chrome Web Store by default (forbids `key`).
const isWebStore = process.env.__WEBSTORE__ !== 'false';

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
    permissions: ['cookies', 'activeTab', 'tabs', 'storage', 'alarms', 'idle', 'scripting'].concat(
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
        description: 'Push current site to cloud',
      },
      'pull-current-site': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: 'Pull current site from cloud',
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
  },
  !isFirefox && { side_panel: { ...sidePanelConfig.side_panel } },
);

export default manifest;
