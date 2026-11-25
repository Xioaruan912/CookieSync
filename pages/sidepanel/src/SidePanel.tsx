import { useGSAP } from '@gsap/react';
import { useTheme, withErrorBoundary, withSuspense } from '@sync-your-cookie/shared';
import { Toaster } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { useEffect, useRef } from 'react';
import CookieTable from './components/CookieTable';

gsap.registerPlugin(useGSAP);

const SidePanel = () => {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closePanel = (message: unknown) => {
      if (message === 'closeSidePanel') window.close();
    };
    chrome.runtime.onMessage.addListener(closePanel);
    return () => chrome.runtime.onMessage.removeListener(closePanel);
  }, []);

  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.from(rootRef.current, { y: 8, opacity: 0, duration: 0.24, ease: 'power3.out', clearProps: 'transform' });
    },
    { scope: rootRef },
  );

  const { theme } = useTheme();

  return (
    <div ref={rootRef} className="sidepanel-shell">
      <CookieTable />
      <Toaster
        theme={theme}
        closeButton
        toastOptions={{ duration: 1800 }}
        visibleToasts={1}
        richColors
        position="top-center"
      />
    </div>
  );
};

export default withErrorBoundary(
  withSuspense(SidePanel, <div className="p-4">加载中…</div>),
  <div className="p-4">页面加载失败，请重新打开</div>,
);
