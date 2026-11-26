# CookieSync 油猴版（手机 + PC 双端适配）

[一键安装油猴脚本](https://raw.githubusercontent.com/Xioaruan912/CookieSync/tampermonkey/userscript/CookieSync-config.user.js) · [Chrome 扩展主分支](https://github.com/Xioaruan912/CookieSync)

专为**手机端浏览器**（如 iOS Userscripts / Stay、Android Tampermonkey / Kiwi / Via）与轻量 PC 浏览器打造的 CookieSync 配置同步脚本，与 Chrome 扩展共用同一份私人 WebDAV 配置。

## 手机与 PC 体验升级（v2.0.0）

- **手机端底部抽屉 + PC 极简居中弹窗**：手机屏幕自动以贴合单手操作的底部抽屉呈现（支持安全区避让），PC 端以纯白/纯黑 Swiss-Tokyo 极简弹窗展示，自动跟随系统浅色/深色外观。
- **检测到 Chrome 扩展自动让位**：在 PC 上如果同时装了 CookieSync Chrome 扩展和油猴脚本，油猴脚本会自动检测到扩展存在并**静默停用后台自动同步**，彻底避免两端同时写入冲突；手机端无扩展时正常自动运行。

## 快速上手

1. 在手机或 PC 浏览器安装 Tampermonkey（或兼容油猴管理器），点击上方「一键安装油猴脚本」。
2. 打开任意 HTTPS 网页，在油猴菜单选择 **「CookieSync · 配置同步」**。
3. 填入与 Chrome 扩展相同的私人 WebDAV 目录地址、用户名与应用密码，保存后即可双向同步网站名单与基础偏好。

## 许可证与致谢

基于 [jackluson/sync-your-cookie](https://github.com/jackluson/sync-your-cookie) 二次开发，采用 **MIT 许可证**。
