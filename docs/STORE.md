# Chrome 商店分发与自动更新

## 当前状态

源码及生产 ZIP 可用于创建商店草稿；当前尚未注册商店开发者账号、创建商店条目或提交审核。此文为上架材料草稿和准备清单，不表示已通过商店审核。真实 Google 授权和双机 Drive 使用仍需测试用户验证。

商店版首次安装后，Chrome 会在新版本审核发布后自动检查并更新；这是版本更新，不是开发环境热重载，也不保证提交后立即生效。商店扩展可随同一 Google 账号的扩展同步设置恢复安装。Cookie 数据继续通过用户选择的 Drive / WebDAV / Gist / KV 同步，Google 登录授权仍可能需要在新电脑首次确认。

## 首次上架顺序

1. 打开 [开发者控制台](https://chrome.google.com/webstore/devconsole)，注册开发者账号、完成页面要求的一次性注册费和账号信息，并开启两步验证。费用、条款和支付由账号持有人确认。
2. 用 Releases 中的 `CookieSync-chrome-版本号.zip` 创建一个**未提交审核的草稿条目**。Source code ZIP 不是扩展包。首次条目必须在控制台创建，商店 API 不能创建新条目。
3. 记录商店实际分配的 Item ID 和 Package 页公钥。将其与当前解压版 `mlgghgdchflafjaegkneinnockfeboei` 比较；若不同，须先规划一次配置迁移，再将商店公钥、对应扩展 ID 和 Google Chrome Extension OAuth 客户端统一。不要直接覆盖当前公钥后让所有解压版用户丢失设置。以商店实际身份为准，不承诺保留任意本地生成的 ID。
4. 完成下方商店描述、隐私问卷、权限用途及真实截图。隐私政策可使用公开仓库的 [PRIVACY.md](https://github.com/Xioaruan912/CookieSync/blob/main/PRIVACY.md)；正式 Google 品牌验证如要求自有已验证网域，应提供维护者可验证的网站。
5. 先完成“审核前待处理项”的检查、真实账号授权和双机同步验证，再提交审核。通过后用户统一从商店安装；已使用解压版的用户需按迁移指引首次安装商店版，不能仅靠 GitHub 更新把本地解压版变成商店版。

## 商店文案草稿

名称：CookieSync · 登录状态同步

简短描述：在自己的电脑间同步指定网站的 Cookie 与 LocalStorage，支持 Google Drive、WebDAV、GitHub Gist 和 Cloudflare KV。

详细描述：

CookieSync 帮助你在自己的电脑之间备份和恢复已登记网站的登录状态，适用于小红书、抖音、115 等网站及用户自行登记的站点。

- 可选 Google Drive 的隐藏应用数据目录，或自己的 HTTPS WebDAV；保留 GitHub Gist、Cloudflare KV 同步后端。
- 支持按网站手动推送、拉取，以及默认每两分钟的后台变化检查。
- 使用内容哈希比较，内容相同跳过上传；云端无数据时为已开启自动推送的网站建立首份备份。
- 支持可选 AES-256-GCM 数据加密；本地与云端同时变化时保留任务并提示冲突。
- 可选随 Chrome 账号同步 WebDAV 配置；此选项包含应用密码，需用户主动开启。

同步内容可能包含等同登录凭据的 Cookie / LocalStorage。请仅同步自己的账号，使用私人存储，保护 Google / WebDAV 等账号，并考虑开启数据加密。扩展不保证绕过网站设备验证、登录过期或服务器撤销会话。默认不开启所有访问站点的自动同步。

本项目基于 jackluson/sync-your-cookie 二次开发，保留 MIT 许可证及原作者版权。

## 隐私问卷与权限用途草稿

不要申报“不处理用户数据”。Cookie 和会话令牌属于认证信息，页面 LocalStorage 还可能包含网站内容或个人数据。须按商店表单实际字段如实勾选认证信息、个人身份信息（Drive 邮箱 / 标识）以及同步中涉及的网站数据类别，并与界面和隐私政策一致；不能宣称“完全不离开本机”。

单一用途：用户在自己的设备间同步其指定站点的登录状态与相关站点存储。

| 权限 | 当前功能用途 |
| --- | --- |
| cookies | 读取、恢复用户登记站点的登录 Cookie，监听变化 |
| storage | 存放配置、本地缓存、离线任务和可选 Chrome 同步配置 |
| identity | 用户点击发起 Google / GitHub 授权，后台静默获取已授予范围的 Google 令牌 |
| alarms | 按设置低频执行后台检查及失败重试 |
| sidePanel | 打开同步管理侧栏 |
| contextMenus | 用户开启右键菜单功能后提供推送／拉取入口 |
| tabs / activeTab | 当前实现使用标签页信息定位站点、与内容脚本交换 LocalStorage、按需刷新；提交前需核实最小权限，移除冗余项或改为可选授权后重新回归 |
| 全站主机访问 / 内容脚本 | 支持用户自行登记任意站点、在对应页面读取／恢复 LocalStorage、访问用户自定义 WebDAV 主机；当前范围较宽，需评估按登记站点请求可选权限，或向审核方充分解释不可缩小的真实功能用途 |

## 审核前待处理项

- 在产品内提供准确、显著的数据使用说明和明确同意；核查首次自动同步前的告知是否满足商店要求，不能仅凭仓库中的政策文档替代用户告知。
- 完成权限最小化评估，尤其是 `<all_urls>`、全站内容脚本、tabs 与 activeTab 的必要性。
- 检查 GitHub Gist 新用户授权：继承的 OAuth 流程尚需自有维护者客户端与回调配置，并校验返回 state；已有保存令牌的后端功能与全新授权要分别验证。不要为商店发布嵌入 client secret。
- Google Auth 项目当前处于测试状态，公开用户需完成品牌、隐私政策、支持联系方式和适用的发布／验证要求。Chrome 商店审核与 Google OAuth 发布独立进行。
- 提供至少一张真实界面截图，尺寸 1280×800 或 640×400，以及符合商店要求的 128×128 PNG 图标。截图用虚拟账号和虚拟 Cookie，不显示真实凭据；不要用虚构成功状态代替真实界面。
- 测试安装、升级保留配置、后台重启、云端为空首次上传、相同哈希跳过上传、断网队列、双端冲突、Cookie 过期及新设备恢复。

## 后续版本更新

增加 `package.json` 的扩展版本号 → 构建验证 → 将同一商店条目的新版 ZIP 上传并提交审核 → 审核通过后发布 → Chrome 自动更新已安装的商店版。

GitHub Releases 已自动化；发布到 Releases 本身不会更新 Chrome 商店。首次商店条目和发布者身份建立后，可用 Chrome Web Store API V2 自动上传与提交审核。该维护者授权必须与终端用户的 Drive OAuth 分开：发布工具使用 `chromewebstore` 范围，**不要把此权限加入用户插件的 Google 登录范围**。客户端密钥和刷新令牌仅放 CI Secrets，不写进扩展或源码。

不要添加指向 GitHub ZIP 的 update_url：Chrome 不会把它作为正式商店更新源，Windows / macOS 的普通用户安装也不能靠自托管绕过商店分发限制。商店负责更新与签名，不需自行写热更新器、下载执行远程代码或强制频繁调用 runtime.reload。

参考：[官方分发方式](https://developer.chrome.com/docs/extensions/how-to/distribute)、[注册开发者](https://developer.chrome.com/docs/webstore/register/)、[首次发布](https://developer.chrome.com/docs/webstore/publish)、[商店 API](https://developer.chrome.com/docs/webstore/using-api)、[权限及用户数据政策](https://developer.chrome.com/docs/webstore/program-policies/policies)、[图片要求](https://developer.chrome.com/docs/webstore/images)。
