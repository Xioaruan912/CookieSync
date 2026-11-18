import { useTheme, withErrorBoundary, withSuspense } from '@sync-your-cookie/shared';
import { Toaster } from '@sync-your-cookie/ui';
import { useEffect } from 'react';
import CookieTable from './components/CookieTable';
const SidePanel = () => {
  useEffect(() => {
    const closePanel = (message: unknown) => {
      if (message === 'closeSidePanel') window.close();
    };
    chrome.runtime.onMessage.addListener(closePanel);
    return () => chrome.runtime.onMessage.removeListener(closePanel);
  }, []);
  const { theme } = useTheme();

  return (
    <div className="">
      <CookieTable />
      <Toaster
        theme={theme}
        closeButton
        toastOptions={{
          duration: 1500,
          style: {
            // width: 'max-content',
            // margin: '0 auto',
          },
          // className: 'w-[240px]',
        }}
        visibleToasts={1}
        richColors
        position="top-center"
      />
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <div> 加载中… </div>), <div> 页面加载失败，请重新打开 </div>);
