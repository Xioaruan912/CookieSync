import { useStorageSuspense } from '@sync-your-cookie/shared';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { siteActivityStorage } from '@sync-your-cookie/storage/lib/siteActivityStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';

const probeKey = 'cookiesync-webdav-probe-ok';

/**
 * Editorial 3-step onboarding band. Retires automatically once all 3 steps complete.
 */
export function ConnectionGuide() {
  const saved = useStorageSuspense(webdavStorage);
  const activity = useStorageSuspense(siteActivityStorage);
  const cookies = useStorageSuspense(cookieStorage);
  const [probeAt, setProbeAt] = useState(0);

  useEffect(() => {
    const read = () => {
      void chrome.storage.local
        .get(probeKey)
        .then(value => setProbeAt(Number(value[probeKey]) || 0))
        .catch(() => {});
    };
    read();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[probeKey]) read();
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  const filled = !!saved.url.trim() && !!saved.username.trim() && !!saved.password;
  const pushed =
    Object.values(activity).some(entry => entry.lastPushAt) ||
    Object.keys(cookies.domainCookieMap || {}).length > 0;
  const tested = probeAt > 0 || pushed;
  if (filled && tested && pushed) return null;

  const steps = [
    { num: '01', title: '填写 WebDAV 凭据', done: filled },
    { num: '02', title: '测试读写权限', done: tested },
    { num: '03', title: '推送第一个网站', done: pushed },
  ];

  return (
    <section className="sbo-band" aria-label="首次配置引导">
      <div className="sbo-label-col">
        <p className="sbo-label">Quick Start</p>
        <p className="sbo-label-sub">完成后自动隐藏。</p>
      </div>
      <div className="sbo-content-col">
        <div className="sbo-guide-list">
          {steps.map(step => (
            <div key={step.num} className="sbo-guide-item" data-done={step.done}>
              <span className="sbo-guide-num">
                {step.done ? <Check size={12} aria-hidden="true" /> : null}
                {step.num}
              </span>
              <strong>{step.title}</strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
