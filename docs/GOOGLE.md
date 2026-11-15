# Google 同步

## WebDAV 配置随 Chrome 账号同步

在 WebDAV 设置中勾选“使用 Chrome / Google 账号同步此 WebDAV 配置”，然后保存。同步内容包含 URL、用户名、应用密码、文件路径和兼容模式；Cookie 文件仍保存在 WebDAV，不会放入 Chrome Sync。

两台电脑需登录同一 Chrome 账号、启用浏览器同步和扩展设置同步，并安装同一版本 CookieSync。同步由 Chrome 调度，可能有延迟；仅登录 Google 网页或 Google Drive 不等于开启 Chrome 同步。未勾选时凭据仍仅保存在本机。关闭后移除云端配置记录，保留已同步电脑上的本机副本；第三方备份和历史记录不保证立即删除。

应用密码会进入 Chrome 同步存储，扩展未对该配置另行加密。请使用专用可撤销的 WebDAV 应用密码，并保护 Google 账号。同步失败时界面会提示；不要反复卸载插件，卸载会删除本机设置。

## Google Drive Cookie 后端

1.7.1 官方安装包已预置 CookieSync 的 OAuth 客户端。若 Google 项目仍处于测试状态，维护者需先把使用者的 Google 邮箱加入测试用户列表；这不等于已向所有用户公开授权。无需在扩展界面输入客户端 ID。

维护者开通 Google 登录的安装包中，打开设置 → Google Drive → 使用 Google 登录。首次同意 CookieSync 的应用数据目录权限后，会切换到 Drive 后端，后续沿用自动推送／拉取和默认 2 分钟检查。每台电脑首次连接一次，使用同一 Google 账号。

扩展只请求 `https://www.googleapis.com/auth/drive.appdata`，使用隐藏的 `appDataFolder`，文件名为 `CookieSync-cookies-v1.txt`。它不会出现在普通“我的云端硬盘”文件列表中，也不会读取你的其他文件。断开保留云端文件；可在 Google Drive 管理应用中处理隐藏应用数据。切换后端不会自动迁移旧文件；如需迁移，先备份并在正确电脑手动确认推送方向。

令牌由 Chrome Identity API 缓存及处理过期，扩展不将令牌写入 Chrome Sync，也没有自建授权服务器。后台只静默请求授权；授权撤销、Chrome 登出、网络限制或 Google 要求重新验证时需点击重新连接。账号变化会停止写入。首次创建同步文件尽量只在一台电脑操作；检测到重复文件或缺失强 ETag 时停止覆盖，不自动猜测正确副本。

内容仍支持 SHA-256 变化检测、按站点合并和原有 AES-256-GCM 加密。建议在高级设置启用 Protobuf 与加密并设置相同密码。隐藏目录不是加密；Google Drive 可达性也会影响后台同步。

## 1.7.0 固定扩展 ID：一次迁移

旧版没有 manifest 公钥，解压目录不同可导致扩展 ID 不同，Chrome 无法把它们识别为同一个扩展。1.7.0 起固定 ID 为 `mlgghgdchflafjaegkneinnockfeboei`，后续不要更换 `chrome-extension/google-config.json` 中的公钥。

从 1.6.x 首次升级前，请记录 WebDAV 设置和数据加密密码，确认远程文件已备份。固定 ID 相当于一个新的扩展身份，旧身份的本机和云端设置不能自动读取；首次需迁移一次配置，之后再开启配置同步。不要在确认新版本恢复成功前删除旧目录或卸载旧扩展；避免新旧扩展同时自动同步。网站自身 Cookie 不会由扩展升级主动删除。后续版本覆盖固定安装目录并重新加载即可。

## 维护者只需配置一次 OAuth

普通用户无需创建 Google Cloud 项目或填写客户端 ID。正式提供“一键登录”前，维护者需要：

1. 创建自己管理的 Google Cloud 项目，启用 Google Drive API，配置 OAuth 同意屏幕、应用名称、隐私政策和支持信息。
2. 创建 **Chrome Extension** 类型 OAuth 客户端，Item ID 填 `mlgghgdchflafjaegkneinnockfeboei`，范围仅为 `drive.appdata`。按 Google 控制台要求完成应用归属、测试用户及发布配置；测试状态可能仅允许列出的账号使用，公开分发需完成适用的发布要求。
3. 在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 添加 `GOOGLE_CLIENT_ID`，值为自己的 `….apps.googleusercontent.com`。它是公开客户端标识，不是客户端密钥；不要将 client secret 放进扩展。也可将此公开 ID 填入 `chrome-extension/google-config.json` 的 `clientId`。
4. 在 main 重新运行发布工作流或推送变更，下载新 Release，验证真实 Google 账号首次授权、重启静默续用和双机读写。未设置 ID 的包会保留 WebDAV 功能，并明确显示 Google 登录尚未开通。

项目借鉴 Quantum Highlighter PRO 的两层同步体验，独立实现，不复用其 OAuth 客户端、应用身份或源码。参考：[Quantum Highlighter PRO](https://github.com/Jorge-Antonio-Gomez/quantum-highlighter-pro-chrome-extension)、[Chrome OAuth 官方说明](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)、[令牌缓存与授权](https://developer.chrome.com/docs/extensions/reference/api/identity)、[Drive 应用数据目录](https://developers.google.com/workspace/drive/api/guides/appdata)。
