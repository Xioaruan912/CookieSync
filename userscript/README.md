# CookieSync 油猴版（v2.2.1）

> 完整介绍与能力边界说明请直接查看本分支根目录的 [README.md](../README.md)。

- **一键安装**：[CookieSync-config.user.js](https://raw.githubusercontent.com/Xioaruan912/CookieSync/tampermonkey/userscript/CookieSync-config.user.js)
- **赞助支持**：[爱发电（ifdian.net/a/ppeea）](https://ifdian.net/a/ppeea)（自愿赞助，项目完全开源免费）
- **定位**：手机端（iPhone Stay / Safari Userscripts / Android）与轻量 PC 的配置伴侣，负责同步**网站名单**、**基础偏好**与**在线手机状态**；网站登录 Cookie 同步由 [`main` 分支 Chrome 扩展](https://github.com/Xioaruan912/CookieSync) 负责（受浏览器 `HttpOnly` 沙箱限制，油猴版不同步登录态）。
- **本地验证**：
  ```sh
  node --test userscript/config.test.mjs
  ```
