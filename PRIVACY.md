# 隐私说明

CookieSync 为用户自己的电脑同步 Cookie 与可选的 LocalStorage。这些数据可能包含可用于登录的会话凭据。

## 存储与传输

- WebDAV 凭据和连接设置默认保存在本机。用户主动勾选配置同步后，包含应用密码的配置进入 Chrome 同步存储；扩展不会为该配置另行加密。关闭后清除当前云端配置记录，但各设备已保存副本和服务备份需另行处理。
- Google Drive 后端经用户点击授权，仅请求 drive.appdata 范围，向用户自己的隐藏应用数据目录读写 CookieSync 文件；通过 Drive about 接口读取账号标识及邮箱以区分同步目的地。账号连接状态仅存本机，OAuth 令牌由 Chrome Identity 管理，不写入 Chrome 同步存储。
- Cookie 缓存及尚未上传的同步队列保存在本机扩展存储中。
- 原有 GitHub Gist、Cloudflare KV 账号配置及通用设置（包括数据加密密码）使用 Chrome 同步存储，可能随 Chrome 账号同步。
- 用户配置后，扩展向所选 Google Drive、WebDAV、Cloudflare KV 或 GitHub Gist 读写同步数据。Google 授权会访问 Google 登录服务及 www.googleapis.com；GitHub 授权还会访问 GitHub 的授权和用户接口。
- 启用数据加密后，上传数据使用原项目的 AES-256-GCM 加密流程。未启用时，同步文件可能包含明文登录凭据；Protobuf 与 Base64 不提供保密性。

扩展没有自建的同步服务器。第三方服务和 Chrome 账号各自的隐私、保留与访问规则仍适用。本机扩展存储不是系统保险箱，能够访问浏览器资料的本机用户或恶意软件可能读取其中的数据。

## 用户控制

用户可以切换同步目的地、调整自动同步频率，或按网站关闭自动推送和拉取。卸载扩展会移除其浏览器存储，但不会自动删除服务器上的文件、历史版本或备份，需在相应服务中清理。

只同步自己的账号。不要使用公共共享目录或公开 Gist 保存登录数据，不要将真实 Cookie、令牌、密码、浏览器资料或同步文件提交到 GitHub。
