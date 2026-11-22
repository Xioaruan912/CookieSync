# CookieSync 油猴版

[安装油猴脚本](https://raw.githubusercontent.com/Xioaruan912/CookieSync/tampermonkey/userscript/CookieSync-config.user.js) · [GitHub Releases](https://github.com/Xioaruan912/CookieSync/releases)

1. 安装新版 Tampermonkey，再打开上面的脚本安装链接。
2. 打开 [CookieSync 仓库页面](https://github.com/Xioaruan912/CookieSync)，从油猴菜单选择「CookieSync · 配置同步」。
3. 填写 HTTPS WebDAV 目录、用户名和应用密码，点击「保存连接」。首次访问该服务器时，油猴可能请求域名授权，只选择自己使用的 WebDAV 域名。
4. 首次点「合并并同步」验证连接并完成服务器域名授权。之后可等待自动同步。应用密码保存在油猴本机存储中。

## 自动同步

1.1.0 起，打开普通 HTTPS 网页或切回已打开的网页时，脚本会检查是否该同步。默认每个 WebDAV 配置目录和账号在同一浏览器里每 30 分钟最多自动尝试一次，失败后也会限频。浏览器停在空白页或内部页面时，等打开普通 HTTPS 网页才会触发。打开油猴菜单的「CookieSync · 查看同步状态」可以看到最近一次结果。

可在设置面板关闭「打开网页时自动同步」，再点「保存连接」。需要立即同步时，手动点「合并并同步」。设置界面只在项目 GitHub 页面显示，从其他网站的油猴菜单也可打开该页面。

如果普通网页里看不到 CookieSync 菜单，先确认脚本版本至少为 1.1.0、脚本已启用，再检查 Chrome 的 Tampermonkey 扩展详情是否允许用户脚本，以及浏览器是否允许油猴在当前网站访问网页。调整后刷新页面。

## 和 Chrome 扩展共用配置

Chrome 扩展的设置页里，将配置同步通道选择为「WebDAV 配置文件」。假设扩展 WebDAV 地址为 `https://dav.example.com/dav/`，远程文件路径是 `sync/cookies.txt`，那么油猴版的目录填 `https://dav.example.com/dav/sync/`。两端会读写同一个 `CookieSync-config-v1.json`。

脚本面板显示自定义及暂停规则。扩展的内置名单继续由扩展管理。普通设置包括主题、Chrome 右键菜单开关和 Chrome 同步间隔。网站登录状态和站点存储由扩展负责。

不同网站或设置的改动会合并。同一项发生冲突时按修改时间与修订号决定。服务器返回 HTTP 412 时，脚本会重新拉取并尝试合并。服务器缺少强 ETag 时，本机仍保留改动。建议使用支持条件写入的 WebDAV。

## 更新

保持油猴中该脚本的更新检查和自动安装更新开启。脚本通过 GitHub 的 `tampermonkey` 分支检查更新，发布新版本时须递增脚本头的 `@version`。Chrome 扩展继续在 `main` 分支发布。

原项目 [sync-your-cookie](https://github.com/jackluson/sync-your-cookie) 由 [jackluson](https://github.com/jackluson) 创建，采用 MIT 许可证。
