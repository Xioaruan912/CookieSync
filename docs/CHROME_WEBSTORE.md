# Chrome Web Store 上架与发布指南（`chrome` 分支）

本分支（`chrome`）专用于保存和自动构建 **Chrome 应用商店（Chrome Web Store）** 的可上传安装包：

- `chrome-extension/manifest.js` 默认开启 Web Store 模式（**不写入 `key` 字段**）。
- 推送到 `chrome` 分支后，GitHub Actions 会自动运行全量校验，确保 ZIP 不含 `key` 字段且所有文件路径均为 ASCII，并自动发布到 GitHub Release **`chrome-v<version>`**（附件 `CookieSync-webstore-<version>.zip`）。

---

## 本地构建商店包

```bash
node scripts/workspace.mjs verify
```

产物位于上级目录 `../CookieSync-release/CookieSync-webstore-<version>.zip`，直接上传至 Chrome Web Store 开发者后台即可。

---

## 商店审核表单参考（Privacy practices）

### 1. 隐私权政策链接（Privacy Policy URL）

```text
https://github.com/Xioaruan912/CookieSync/blob/main/PRIVACY.md
```

### 2. 单一用途说明（Single purpose description）

```text
Syncs user-selected website login sessions (Cookies, LocalStorage, and IndexedDB) across the user's own browsers via their private WebDAV server with optional end-to-end encryption.
```

### 3. 权限使用理由（Permission justifications）

| 权限 | 说明（可直接粘贴至英文/中文表单） |
| --- | --- |
| `cookies` & `<all_urls>` | Read and restore login cookies for user-selected websites, and run read-only session health checks on adapted sites. |
| `storage` | Store user preferences, site sync allow/deny rules, WebDAV connection settings, and local health check status. |
| `tabs` / `activeTab` / `scripting` | Capture and restore page-level LocalStorage/IndexedDB on user-selected sites, and discard idle single-session tabs on standby devices to prevent session kicks. |
| `alarms` / `idle` | Schedule periodic background sync checks and detect 90-second user inactivity for single-active-device handover. |
| `sidePanel` / `contextMenus` | Provide the Cookie inspection side panel and right-click menu to add the current site to sync. |

> Note: Off-store GitHub update checks, `downloads` permission, `web_accessible_resources`, and `manifest.key` are completely removed on the `chrome` branch. All extension bundles are also verified to contain zero `eval()` or `new Function()` calls.

### 4. 远程代码（Remote code）

选择 **No（不使用远程代码）**：所有扩展脚本均随安装包本地打包，不动态加载外部 JS。
