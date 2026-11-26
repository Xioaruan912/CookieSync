import { useGSAP } from '@gsap/react';
import { useLocale } from '@sync-your-cookie/shared';
import gsap from 'gsap';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { useRef } from 'react';

gsap.registerPlugin(useGSAP);

export function AboutSettings() {
  const { t } = useLocale();
  const stageRef = useRef<HTMLDivElement>(null);
  const currentVersion = chrome.runtime.getManifest().version;

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('.about-wordmark', {
          yPercent: 105,
          duration: 0.72,
          ease: 'power4.out',
          clearProps: 'transform',
        });
      });
    },
    { scope: stageRef },
  );

  return (
    <section ref={stageRef} className="about-stage" aria-label={t('关于', 'About')}>
      <div className="about-top-bar">
        <div className="about-wordmark-wrap">
          <h1 id="settings-title" className="about-wordmark">
            About
          </h1>
        </div>
      </div>

      <div className="about-viewport">
        <div className="about-split" role="tabpanel">
          <div className="about-left">
            <div className="about-status-line" role="status">
              <span className="about-status-dot" data-tone="ok" aria-hidden="true" />
              <span>{t('Chrome 应用商店自动更新已托管', 'Managed by Chrome Web Store Auto-Update')}</span>
            </div>

            <h2 className="about-version-hero">v{currentVersion}</h2>

            <p className="about-sub">
              {t(
                '专为双机交替使用、常不关机与单会话防掉线打造的私人网盘登录态同步扩展。所有数据全程保存在你自己的私人 WebDAV 云端，无第三方中转服务器。',
                'Private WebDAV browser session sync built for seamless dual-PC handover and single-session anti-kick protection. Zero third-party relay servers.',
              )}
            </p>
            <p className="about-sub">
              {t(
                '基于 jackluson/sync-your-cookie 二次开发，采用 MIT 开源许可证，完整保留原作者 Jack Lu 的版权声明。',
                'Forked from jackluson/sync-your-cookie under the MIT License with full attribution to original author Jack Lu.',
              )}
            </p>
          </div>

          <div className="about-right">
            <p className="about-kicker">LINKS &amp; PRIVACY</p>
            <a
              href="https://github.com/Xioaruan912/CookieSync"
              target="_blank"
              rel="noreferrer"
              className="about-link-row">
              <span>
                {t('项目仓库', 'Repository')}
                <span className="block about-link-sub">github.com/Xioaruan912/CookieSync</span>
              </span>
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            <a
              href="https://github.com/Xioaruan912/CookieSync/blob/chrome/PRIVACY.md"
              target="_blank"
              rel="noreferrer"
              className="about-link-row">
              <span>
                {t('隐私政策说明', 'Privacy Policy')}
                <span className="block about-link-sub">
                  {t('了解数据仅在你的设备与私人 WebDAV 间直传', 'Learn how data travels strictly between your browser and WebDAV')}
                </span>
              </span>
              <ShieldCheck size={16} aria-hidden="true" />
            </a>
            <a
              href="https://github.com/Xioaruan912/CookieSync/issues"
              target="_blank"
              rel="noreferrer"
              className="about-link-row">
              <span>
                {t('问题反馈与支持', 'Issues & Support')}
                <span className="block about-link-sub">github.com/Xioaruan912/CookieSync/issues</span>
              </span>
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            <a
              href="https://github.com/jackluson/sync-your-cookie"
              target="_blank"
              rel="noreferrer"
              className="about-link-row">
              <span>
                {t('原项目致谢 · Jack Lu', 'Original Project · Jack Lu')}
                <span className="block about-link-sub">github.com/jackluson/sync-your-cookie</span>
              </span>
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>

      <div className="about-rail">
        <p className="about-rail-note">CookieSync v{currentVersion} · Chrome Web Store Edition · MIT License</p>
      </div>
    </section>
  );
}
