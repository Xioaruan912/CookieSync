# CookieSync

通过 Google Drive、WebDAV、Cloudflare KV 或 GitHub Gist，在自己的电脑之间同步 Cookie 与 LocalStorage。

基于 [jackluson/sync-your-cookie](https://github.com/jackluson/sync-your-cookie) 二次开发，采用 MIT 许可证，保留原作者 Jack Lu 的版权声明。

## 功能

- WebDAV 地址、用户名、密码／应用密码及远程文件路径配置，支持独立临时文件连接测试。
- 可选通过 Chrome 账号同步 WebDAV 配置，避免第二台电脑重复填写；包含应用密码，需主动开启。
- Google Drive 隐藏应用目录后端，官方安装包已预置 OAuth 客户端，用户点击 Google 登录即可发起授权，令牌由 Chrome 管理。项目处于 Google 测试状态时仅测试用户可授权；维护者配置方法见 [Google 同步说明](docs/GOOGLE.md)。
- 手动推送、拉取并应用、按网站合并；保留 Cloudflare KV 与 GitHub Gist 后端。
- 启动自动拉取，后台默认每 2 分钟合并改动，可调整为 1～60 分钟；离线队列保留并重试，无关闭钩子。
- 连接后主动检查；云端没有对应网站数据时，自动为已开启推送且本机有数据的网站建立备份。设置页可查看检查／上传时间、待同步数量及错误，也可立即检查。
- 简体中文界面，支持 Protobuf 编码及可选 AES-256-GCM 加密。
- 小红书、抖音、115 主域及子域 Cookie 优先处理，修复会话 Cookie 恢复时误设过期时间的问题。

Cookie 失效、服务器撤销会话或设备风控仍可能要求重新登录；不保证免扫码。三个目标网站的测试使用虚拟数据，未使用真实账号。

## 下载安装包

打开 [最新 Releases](https://github.com/Xioaruan912/CookieSync/releases/latest)，在 Assets 下载 **CookieSync-chrome-版本号.zip**。解压后在 `chrome://extensions` 开启开发者模式并加载包含 `manifest.json` 的目录。`SHA256SUMS.txt` 可用于校验安装包。

GitHub 的“Code → Download ZIP”是源码，不是可安装扩展。更新时覆盖原安装目录并重新加载，不要先卸载，以保留本机配置。正式包没有开发重载服务。

**1.6.x 首次升级至 1.7.0 请先记录配置和加密密码。** 新版为跨电脑同步固定扩展 ID，旧身份的配置需迁移一次，随后开启配置同步；后续不再变更 ID。详见 [一次迁移说明](docs/GOOGLE.md#170-固定扩展-id一次迁移)。

## 构建与加载

需要 Node.js 20.12+ 和 pnpm 9.1.1；项目声明的 Node 版本见 `.nvmrc`。

```sh
node scripts/workspace.mjs verify
```

该命令自动在系统临时缓存中安装依赖、构建并运行检查；源码目录始终没有依赖或构建缓存。安装 ZIP 和解压目录位于源码旁边的 `CookieSync-release/`。对已验证源码仅打包可运行 `node scripts/workspace.mjs build`。也可用 `--cache`、`--output` 指定源码外的路径。

两台电脑配置相同的 WebDAV 目的地。小红书、抖音、115 及已登记网站默认自动推送和自动拉取，保留用户明确关闭的设置。建议首次手动推送／拉取确认。详细步骤和限制见 [WebDAV 使用说明](docs/WEBDAV.md)。Cloudflare 配置可参考 [上游说明](https://github.com/jackluson/sync-your-cookie/blob/main/how-to-use.md)。

## 内容比对

使用浏览器原生 **SHA-256** 摘要实现类似 MD5 的内容比对，无新增摘要依赖。比较解密后的 Cookie / LocalStorage，统一顺序并排除更新时间、设备存储编号等无关信息。同内容跳过远程上传和浏览器重复写入；编码或加密策略改变时仍会重写。

后台默认每 2 分钟处理变化并检查远端。本机变化上传，远端变化恢复；两端相对上次基线均变化时保留本机队列并停止覆盖，需手动确认。摘要用于变化检测，不代替加密和 WebDAV 冲突保护。

## 验证

`verify` 会执行完整构建、类型检查及单元测试。可选的浏览器测试使用独立临时资料和虚拟页面，运行方法见 [使用说明](docs/WEBDAV.md)。每次推送到 `main`，GitHub Actions 验证成功后自动发布安装 ZIP 和 SHA-256 校验文件到 Releases，标签为 `v版本号-build.构建号`，保留历史安装包；PR 仅构建验证，不发布。也可在 `main` 手动运行工作流。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `chrome-extension/` | 扩展清单、后台同步与浏览器事件处理 |
| `pages/` | 设置页、弹窗、侧栏及页面脚本 |
| `packages/` | 共享逻辑、存储、编码、界面及构建工具 |
| `tests/` | 可选浏览器冒烟测试 |
| `docs/` | 配置方法、行为边界与验证说明 |
| `.github/` | CI、依赖更新及问题模板 |

依赖、构建产物、缓存、浏览器资料和本机配置均不提交。后续统一在本仓库修改源码，再运行源码外构建命令；不在复制的安装目录中修改实现。

## 安全与隐私

Cookie 和 LocalStorage 可能等同于登录凭据。请使用私人 HTTPS WebDAV、专用应用密码，并在两端启用相同的数据加密设置；Protobuf 或 Base64 本身不是加密。

WebDAV 凭据默认仅存本机；主动开启配置同步后会包含应用密码并进入 Chrome 同步存储。原有 Gist/KV 账号及通用设置仍使用 Chrome 同步存储。详见 [隐私说明](PRIVACY.md)、[Google 同步](docs/GOOGLE.md) 与 [配置及安全说明](docs/WEBDAV.md)。不要向仓库提交真实 Cookie、密码、令牌、同步文件或浏览器资料。

## 许可证

[MIT](LICENSE)。上游来源见开头的链接，原始版权声明保留在许可证中。
