import { useLocale, useStorageSuspense } from '@sync-your-cookie/shared';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { siteActivityStorage } from '@sync-your-cookie/storage/lib/siteActivityStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';

const probeKey = 'cookiesync-webdav-probe-ok';

/**
 * Compact 1-line inline onboarding progress in the bottom rail.
 * Disappears automatically once all 3 steps complete.
 */
export function ConnectionGuide() {
  const { t } = useLocale();
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
  if (filled && tested && pushed)
    return (
      <span className="sbo-guide-inline">
        {t('凭据仅存本机 · 建议开启 AES-256-GCM 加密', 'Credentials stay local · AES-256-GCM encryption recommended')}
      </span>
    );

  const steps = [
    { num: '01', title: t('填写凭据', 'Credentials'), done: filled },
    { num: '02', title: t('测试权限', 'Test Access'), done: tested },
    { num: '03', title: t('推送首站', 'First Push'), done: pushed },
  ];

  return (
    <div className="sbo-guide-inline" aria-label={t('首次配置引导', 'Setup guide')}>
      {steps.map(step => (
        <span key={step.num} className="sbo-guide-step" data-done={step.done}>
          {step.done ? <Check size={12} aria-hidden="true" /> : <span>{step.num}</span>}
          <span>{step.title}</span>
        </span>
      ))}
    </div>
  );
}
