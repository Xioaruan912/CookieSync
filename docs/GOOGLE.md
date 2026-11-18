# Google 同步

## WebDAV 配置随 Chrome 账号同步

在 WebDAV 设置中勾选“使用 Chrome / Google 账号同步此 WebDAV 配置”，然后保存。同步内容包含 URL、用户名、应用密码、文件路径和兼容模式；Cookie 文件仍保存在 WebDAV，不会放入 Chrome Sync。

两台电脑需登录同一 Chrome 账号、启用浏览器同步和扩展设置同步，并安装同一版本 CookieSync。同步由 Chrome 调度，可能有延迟；仅登录 Google 网页或 Google Drive 不等于开启 Chrome 同步。未勾选时凭据仍仅保存在本机。关闭后移除云端配置记录，保留已同步电脑上的本机副本；第三方备份和历史记录不保证立即删除。

应用密码会进入 Chrome 同步存储，扩展未对该配置另行加密。请使用专用可撤销的 WebDAV 应用密码，并保护 Google 账号。同步失败时界面会提示；不要反复卸载插件，卸载会删除本机设置。

## Google Drive Cookie 后端

1.9.0 起默认使用[内置 300 站＋自定义名单](SITES.md)。设置页可搜索、开关或添加域名。名单覆盖规则默认进入 Chrome 配置同步；已连接 Google Drive 后，自动检查先读取独立的 `CookieSync-sites-v1.json`，逐域合并后再处理 Cookie，配置内容一致时不重复上传。不需要新增 OAuth 范围或客户端 ID。名单不包含登录凭据，未另行加密；Cookie 文件及其加密设置保持独立。名单外旧站点和队列暂停自动收发，数据保留。

两台电脑的不同网站修改会合并，同一域名采用较新修改（时间相同以版本标识确定顺序）。关闭记录保留，避免另一台旧电脑把站点重新启用。电脑时钟应准确；Chrome 同步依赖浏览器同步开关，Drive 同步需要每台电脑分别授权同一账号，且仅在自动检查时同步。Chrome 同步是本功能的本机配置层，不通过 Google 网页登录自动开通浏览器同步。

即使 Cookie 后端改用 WebDAV，已连接的 Drive 仍会同步名单；不需要 Drive 名单同步时可断开 Google Drive。Drive 读取失败时自动任务会停止并显示错误，避免在尚未取得云端关闭规则时回放旧队列。手动 Cookie 推送、拉取不受名单限制。

1.7.1 官方安装包已预置 CookieSync 的 OAuth 客户端。若 Google 项目仍处于测试状态，维护者需先把使用者的 Google 邮箱加入测试用户列表；这不等于已向所有用户公开授权。无需在扩展界面输入客户端 ID。

1.7.2 修复连接后未立即初始化自动同步、首次上传延迟一个周期及仅推送站点跳过建档的问题。连接后会扫描已开启推送的站点：云端不存在且本机有 Cookie / LocalStorage 时在首轮上传；之后默认每两分钟检查，内容哈希相同则跳过。设置页新增自动同步状态和“立即检查并同步”。被浏览器清掉的会话 Cookie 优先从已有云端备份恢复，不能用被动发现的空本机状态覆盖登录数据。

维护者开通 Google 登录的安装包中，打开设置 → Google Drive → 使用 Google 登录。首次同意 CookieSync 的应用数据目录权限后，会切换到 Drive 后端，后续沿用自动推送／拉取和默认 2 分钟检查。每台电脑首次连接一次，使用同一 Google 账号。

扩展只请求 `https://www.googleapis.com/auth/drive.appdata`，使用隐藏的 `appDataFolder`，文件名为 `CookieSync-cookies-v1.txt`。它不会出现在普通“我的云端硬盘”文件列表中，也不会读取你的其他文件。断开保留云端文件；可在 Google Drive 管理应用中处理隐藏应用数据。切换后端不会自动迁移旧文件；如需迁移，先备份并在正确电脑手动确认推送方向。

令牌由 Chrome Identity API 缓存及处理过期，扩展不将令牌写入 Chrome Sync，也没有自建授权服务器。后台只静默请求授权；授权撤销、Chrome 登出、网络限制或 Google 要求重新验证时需点击重新连接。账号变化会停止写入。首次创建 Cookie 数据文件尽量只在一台电脑操作；检测到重复文件或缺失强 ETag 时停止覆盖，不自动猜测正确副本。

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

## 两台电脑同时修改配置

1.11.0 起，Drive 为网站名单和普通扩展偏好追加独立的配置快照。升级两台电脑并连接同一 Drive 账号后，扩展会读取旧版名单和所有新快照。不同网站、不同偏好分别合并。若两台电脑对同一项给出不同值，采用修改时间较晚的一项，时间相同时以修订编号决定。电脑时钟差异可能影响同一项的选择。

Drive 普通偏好包括主题、右键菜单开关和同步间隔。密码、授权令牌、加密设置和本机收发开关不进入配置快照。修改失败时，本机记录保留至下次重试。后台定期检查时也会读取配置；内容相同会跳过上传。新快照保留在应用数据目录中。

错误以「网站名单与扩展设置」或「Cookie 数据」标明来源。配置同步无需强 ETag；Cookie 数据继续使用原有条件写入。
