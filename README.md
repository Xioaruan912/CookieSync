<div align="center">

<h1>CookieSync · 油猴版</h1>

<p><strong>手机与 PC 跨端配置同步伴侣（v2.2.1）</strong><br />面向 iPhone（Stay / Userscripts）、Android 与轻量桌面浏览器，与 Chrome 扩展共用同一份私人网盘名单与偏好。</p>

<p>
  <a href="https://raw.githubusercontent.com/Xioaruan912/CookieSync/tampermonkey/userscript/CookieSync-config.user.js"><strong>一键安装油猴脚本</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/Xioaruan912/CookieSync">Chrome 扩展主分支（登录态同步）</a> &nbsp;·&nbsp;
  <a href="#3-步上手">3 步上手</a> &nbsp;·&nbsp;
  <a href="#能力边界说明必读">能力边界说明</a> &nbsp;·&nbsp;
  <a href="https://ifdian.net/a/ppeea"><strong>⚡ 爱发电赞助</strong></a>
</p>

</div>

---

## 能力边界说明（必读）

> 在安装前，请先了解油猴版与 Chrome 扩展的明确分工：

| 同步内容 | Chrome 扩展（PC / 支持扩展的 Android 浏览器） | 油猴版（本分支，iPhone Stay / 手机 / PC） |
| :--- | :---: | :---: |
| **网站同步名单（添加 / 暂停 / 预设）** | 支持（与油猴共用） | **支持（与扩展共用）** |
| **基础偏好设置（主题 / 间隔 / 菜单）** | 支持（与油猴共用） | **支持（与扩展共用）** |
| **在线设备状态（总览页显示在线手机）** | 支持（`desktop` 独立槽位） | **支持（`mobile` 独立槽位）** |
| **网站登录态（Cookie / LocalStorage）** | **支持（完整读写 `HttpOnly`）** | **不支持** |

**为什么油猴版不同步登录 Cookie？**
- 绝大多数网站（GitHub、115、知乎、B站、抖音等）的核心登录凭据都带有浏览器安全保护标记 **`HttpOnly`**。
- **iPhone 的 Stay、Safari Userscripts、Violentmonkey、Via 等主流油猴管理器受浏览器网页沙箱限制，无法读写 `HttpOnly` Cookie**（桌面端仅 Tampermonkey BETA 有非标准私有接口，但 PC 上直接使用我们的 Chrome 扩展功能更完整、更稳定）。
- 如果你需要在 **Android 手机** 上同步完整登录态，可在支持 Chrome 扩展的浏览器（如 Kiwi / Lemur / Edge Canary）直接安装 `main` 分支的扩展 ZIP；如果在 **iPhone Safari** 上同步完整登录态，需通过 macOS Xcode 将主分支扩展打包为原生 **iOS Safari Web Extension**。

---

## 核心特性

- **手机优先 + PC 双端适配**：手机端自动以贴合单手操作的原生底部抽屉呈现（支持安全区避让），PC 端以纯白 / 纯黑极简居中弹窗展示，自动跟随系统浅色 / 深色外观。
- **当前网站一键加入 + 18 个高频预设名单**：在「名单」页或油猴菜单直接一键将当前网页加入同步名单，也内置了 115、GitHub、B站、知乎、抖音、小红书等高频预设站点，点一下即可切换。
- **检测到 Chrome 扩展自动让位**：如果同一台 PC 同时装了 CookieSync Chrome 扩展与油猴脚本，油猴会自动检测到扩展运行并**静默停用后台自动同步**，彻底避免两端同时写入冲突。
- **多端双槽位互不干扰**：手机端使用独立的 `mobile` 在线槽位，与 PC 端的 `desktop` 槽位完全隔离；你可以一边用电脑、一边用手机管理名单，并在 PC 扩展总览页看到当前在线的手机名称（如 `iPhone Safari 在线`）。
- **广泛兼容主流手机油猴管理器**：内置兼容层，完整支持 **iPhone Stay**、**Safari Userscripts**、**Android Tampermonkey / Via** 与桌面端 **Tampermonkey / Violentmonkey**。
- **内置一键检查更新**：在面板「概览」页或油猴菜单点击「检查更新」，即可自动比对最新版本并一键跳转安装更新。

---

## 3 步上手

1. **安装脚本**：在手机（如 iPhone 安装 **Stay**）或 PC 浏览器安装油猴管理器后，点击顶部 **[一键安装油猴脚本](https://raw.githubusercontent.com/Xioaruan912/CookieSync/tampermonkey/userscript/CookieSync-config.user.js)**。
2. **填写私人网盘目录**：打开任意普通 HTTPS 网页，在油猴菜单选择 **「CookieSync · 配置同步」**，填入与 Chrome 扩展一致的私人 HTTPS WebDAV 目录、用户名与应用密码，保存连接。
   > 示例：如果 Chrome 扩展的 WebDAV 地址是 `https://dav.jianguoyun.com/dav/`、远程路径是 `CookieSync/cookies.txt`，那么油猴版的目录直接填 `https://dav.jianguoyun.com/dav/CookieSync/`，并在 Chrome 扩展里将配置同步通道选为「WebDAV 配置文件」。
3. **开始使用**：点击「立即同步」完成首次授权与合并；之后在手机浏览任意网页时，点油猴菜单的 **「一键加入 xxx.com」** 即可同步到你的 PC 扩展。

---

<details>
<summary><strong>进阶说明与本地测试（面向开发者）</strong></summary>

<br />

- **同步机制**：仅读写你私人 WebDAV 目录下的 `CookieSync-config-v1.json`（逐字段 `updatedAt + revision` 合并 + `If-Match / ETag` 条件写入，不含 WebDAV 密码与加密密码）以及 `CookieSync-lease-v1.json` 的 `slots.mobile` 槽位。
- **自动限频**：后台自动同步默认每 30 分钟最多触发一次；遇到多端并发 `HTTP 412` 自动重新拉取并合并。
- **脚本路径**：[userscript/CookieSync-config.user.js](userscript/CookieSync-config.user.js)
- **运行单元测试**（需要 Node.js 20+）：
  ```sh
  node --test userscript/config.test.mjs
  ```

</details>

---

## 赞助支持

如果 CookieSync 帮你省下了跨设备折腾的时间，欢迎通过爱发电请作者喝杯咖啡，支持项目持续维护与免费开源：

<a href="https://ifdian.net/a/ppeea" target="_blank" rel="noreferrer">
  <img src="https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E8%B5%9E%E5%8A%A9%E6%94%AF%E6%8C%81-946ce6?style=for-the-badge" alt="爱发电赞助支持" />
</a>

> 所有赞助均为自愿支持，CookieSync 全部功能保持完全开源免费。

---

## 许可证与致谢

基于 [jackluson/sync-your-cookie](https://github.com/jackluson/sync-your-cookie) 二次开发，采用 **[MIT 许可证](LICENSE)**，完整保留原作者 **Jack Lu** 的版权声明。
