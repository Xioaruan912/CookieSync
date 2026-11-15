# CookieSync

通过 WebDAV、Cloudflare KV 或 GitHub Gist，在自己的电脑之间同步 Cookie 与 LocalStorage。

基于 [jackluson/sync-your-cookie](https://github.com/jackluson/sync-your-cookie) 二次开发，采用 MIT 许可证，保留原作者 Jack Lu 的版权声明。

## 功能

- WebDAV 地址、用户名、密码／应用密码及远程文件路径配置，支持独立临时文件连接测试。
- 手动推送、拉取并应用、按网站合并；保留 Cloudflare KV 与 GitHub Gist 后端。
- 启动自动拉取，后台默认每 2 分钟合并改动，可调整为 1～60 分钟；离线队列保留并重试，无关闭钩子。
- 简体中文界面，支持 Protobuf 编码及可选 AES-256-GCM 加密。
- 小红书、抖音、115 主域及子域 Cookie 优先处理，修复会话 Cookie 恢复时误设过期时间的问题。

Cookie 失效、服务器撤销会话或设备风控仍可能要求重新登录；不保证免扫码。三个目标网站的测试使用虚拟数据，未使用真实账号。

## 构建与加载

需要 Node.js 20.12+ 和 pnpm 9.1.1；项目声明的 Node 版本见 `.nvmrc`。

```sh
pnpm install --frozen-lockfile
pnpm build
```

在 Chrome 打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，加载根目录 `dist/`。

两台电脑分别配置相同的 WebDAV 目的地。首次在已登录电脑推送，在另一台拉取；之后可使用自动同步。详细步骤和限制见 [WebDAV 使用说明](docs/WEBDAV.md)。原有 Cloudflare 配置步骤可参考 [上游说明](https://github.com/jackluson/sync-your-cookie/blob/main/how-to-use.md)。

## 验证

```sh
pnpm type-check
pnpm test
```

可选浏览器测试：

```sh
python -m pip install -r tests/requirements-browser.txt
python -m playwright install chromium
python tests/browser-smoke.py
```

浏览器测试使用独立临时资料、本机 WebDAV 和虚拟页面。GitHub Actions 执行构建、类型检查、单元测试并提供扩展产物。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `chrome-extension/` | 扩展清单、后台同步与浏览器事件处理 |
| `pages/` | 设置页、弹窗、侧栏及页面脚本 |
| `packages/` | 共享逻辑、存储、编码、界面及构建工具 |
| `tests/` | 可选浏览器冒烟测试 |
| `docs/` | 配置方法、行为边界与验证说明 |
| `.github/` | CI、依赖更新及问题模板 |

依赖、构建产物、缓存、浏览器资料和本机配置均不提交。首次检出或清理后执行 `pnpm install --frozen-lockfile` 恢复开发环境。

## 安全与隐私

Cookie 和 LocalStorage 可能等同于登录凭据。请使用私人 HTTPS WebDAV、专用应用密码，并在两端启用相同的数据加密设置；Protobuf 或 Base64 本身不是加密。

WebDAV 凭据仅保存在本机扩展存储。原有 Gist/KV 账号及通用设置仍使用 Chrome 同步存储。详见 [隐私说明](PRIVACY.md) 与 [配置及安全说明](docs/WEBDAV.md)。不要向仓库提交真实 Cookie、密码、令牌、同步文件或浏览器资料。

## 许可证

[MIT](LICENSE)。上游来源见开头的链接，原始版权声明保留在许可证中。
