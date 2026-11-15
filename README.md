# CookieSync · WebDAV 与简体中文分支

基于 [jackluson/sync-your-cookie](https://github.com/jackluson/sync-your-cookie) 的 MIT 二次开发版本。新增 WebDAV 同步配置、连接测试和后端，汉化设置、弹窗与管理侧栏，保留 Cloudflare KV 与 GitHub Gist。

- WebDAV URL、用户名、密码／应用密码、远程文件路径；凭据仅保存本机。
- 手动推送、拉取并应用、按网站合并；增加浏览器启动自动拉取、后台增量同步与本机离线队列（默认每 2 分钟合并，无关闭钩子）。
- HTTPS、超时、防重定向、ETag 条件写；连接测试使用独立临时文件。
- 继续支持原有 Protobuf 编码、LocalStorage 和可选 AES-256-GCM 加密。
- 小红书、抖音、115 主域及子域 Cookie 优先处理，修复会话 Cookie 误设过期时间。

安装、配置、合并规则、自动同步限制与安全风险见 **[WebDAV 使用说明](docs/WEBDAV.md)**。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm type-check
pnpm test
```

Chrome 开发者模式中加载根目录 `dist/`。不要将依赖、构建目录、浏览器资料或真实 Cookie / 密码提交到 GitHub。Cookie 同步不能保证绕过小红书、抖音等网站的设备风控或重新验证。

以下保留原项目说明及作者信息。

---

<div align="center">
<img src="chrome-extension/public/icon-128.png" alt="logo"/>
<h1> Sync your cookie to Your Cloudflare or Github Gist</h1>

![](https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black)
![](https://img.shields.io/badge/Typescript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![](https://badges.aleen42.com/src/vitejs.svg)
![GitHub action badge](https://github.com/jackluson/sync-your-cookie/actions/workflows/build-zip.yml/badge.svg)
<!-- <img src="https://hits.seeyoufarm.com/api/count/incr/badge.svg?url=https://github.com/jackluson/sync-your-cookieFactions&count_bg=%23#222222&title_bg=%23#454545&title=😀&edge_flat=true" alt="hits"/> -->

</div>

[English](./README.md) | [中文](./README_ZH.md)

`Sync your cookie` is a chrome extension that helps you to sync your cookie to Cloudflare or Github Gist. It's a useful tool for web developers to share cookies between different devices. 

### Install
Chrome: [Sync Your Cookie](https://chromewebstore.google.com/detail/sync-your-cookie/bcegpckmgklcpcapnbigfdadedcneopf)

Edge: [Sync Your Cookie](https://microsoftedge.microsoft.com/addons/detail/sync-your-cookie/ohlcghldllgnmkegocpcphdbbphikgfm)


### Features

- Supports syncing cookies to Cloudflare or Github Gist (Include LocalStorage)
- Supports configuring `Auto Merge` and `Auto Push` rules for different sites
- Cookie data is transmitted via protobuf encoding
- Provides a management panel to facilitate viewing, copying, and managing synchronized cookie data
- Multi-account synchronization based on Storage-key


### Project Screenshots

Account Settings Page

<img width="600" src="./screenshots/settings_v2.png" alt="account settings"/>

Cookie Sync Popup Page

<img width="600" src="./screenshots/sync.png" alt="cookie sync popup"/>

Cookie Manager Sidebar Panel

<img width="600" src="./screenshots/panel.png" alt="cookie manager sidebar panel"/>

Cookie Detail

<img width="600" src="./screenshots/panel_item.png" alt="cookie manager sidebar panel"/>

LocalStorage Detail

<img width="600" src="./screenshots/panel_item_localStorage.png" alt="cookie manager sidebar panel"/>

Pushed Cookie on Github Gist

<img width="600" src="./screenshots/gist.png" alt="Pushed Cookie on Github Gist"/>


Pushed Cookie on Cloudflare

<img width="600" src="./screenshots/key_value.png" alt="Pushed Cookie on Cloudflare"/>


### Usage

[How to use](./how-to-use.md)

### TODO

- [x] Custom Save Configure
- [x] Multi-account synchronization based on Storage-key
- [x] Sync LocalStorage
- [x] More Cloud Platform (First github gist)

### Privacy Policy

Please refer to [Privacy Policy](./private-policy.md) for more information.

### Support

If you find this project helpful, you can support the development by:
- Starring the repository ⭐
- [Sponsoring via Ko-fi](https://ko-fi.com/jacklu) 💖
- Sponsor via Wechat
  <div>
    <img src="./screenshots/wechat_sponsor.jpg" alt="微信支付" style="width: 150px;">
  </div>
- Sharing it with others 🚀
