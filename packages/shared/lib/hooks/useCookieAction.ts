import {
  MessageErrorCode,
  pullCookieUsingMessage,
  pushCookieUsingMessage,
  removeCookieUsingMessage,
} from '@lib/message';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';

import { toast as Toast } from 'sonner';
import { useStorageSuspense } from './index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const catchHandler = (err: any, scene: 'push' | 'pull' | 'remove' | 'delete' | 'edit', toast: typeof Toast) => {
  const defaultMsg = '同步操作失败，请重试';
  const code = err?.code;
  const settingErrors = [
    MessageErrorCode.AccountCheck,
    MessageErrorCode.DecodeFailed,
    MessageErrorCode.DecryptFailed,
  ];
  if (settingErrors.includes(code)) {
    toast.error(err?.msg || err?.message || err?.result?.message || defaultMsg, {
      action: {
        label: '前往设置',
        onClick: () => {
          chrome.runtime.openOptionsPage();
        },
      },
    });
  } else {
    toast.error(err?.msg || err?.message || defaultMsg);
  }
};

export const useCookieAction = (host: string, toast: typeof Toast) => {
  const domainStatus = useStorageSuspense(domainStatusStorage);
  const domainConfig = useStorageSuspense(domainConfigStorage);

  const handlePush = async (selectedHost = host, sourceUrl?: string, favIconUrl?: string) => {
    return pushCookieUsingMessage({
      host: selectedHost,
      sourceUrl,
      favIconUrl,
    })
      .then(res => {
        if (res.isOk) {
          toast.success('推送成功');
        } else {
          toast.error(res.msg || '推送失败');
        }
      })
      .catch(err => {
        catchHandler(err, 'push', toast);
      });
  };

  const handlePull = async (activeTabUrl: string, selectedDomain = host, reload = true) => {
    return pullCookieUsingMessage({
      activeTabUrl: activeTabUrl,
      domain: selectedDomain,
      reload,
    })
      .then(res => {
        if (res.isOk) {
          toast.success('拉取成功');
        } else {
          toast.error(res.msg || '拉取失败');
        }
      })
      .catch(err => {
        catchHandler(err, 'pull', toast);
      });
  };

  const handleRemove = async (selectedDomain = host) => {
    return removeCookieUsingMessage({
      domain: selectedDomain,
    })
      .then(async res => {
        if (res.isOk) {
          toast.success(res.msg || 'success');
          await domainConfigStorage.removeItem(host);
        } else {
          toast.error(res.msg || '移除失败');
        }
      })
      .catch(err => {
        catchHandler(err, 'remove', toast);
      });
  };

  return {
    // domainConfig: domainConfig as typeof domainConfig,
    pulling: domainStatus.pulling,
    pushing: domainStatus.pushing,
    domainItemConfig: { autoPush: true, autoPull: true, ...domainConfig.domainMap[host] },
    domainItemStatus: domainStatus.domainMap[host] || {},
    getDomainItemConfig: (selectedDomain: string) => {
      return { autoPush: true, autoPull: true, ...domainConfig.domainMap[selectedDomain] };
    },
    getDomainItemStatus: (selectedDomain: string) => {
      return domainStatus.domainMap[selectedDomain] || {};
    },
    toggleAutoPullState: domainConfigStorage.toggleAutoPullState,
    toggleAutoPushState: domainConfigStorage.toggleAutoPushState,
    togglePullingState: domainStatusStorage.togglePullingState,
    togglePushingState: domainStatusStorage.togglePushingState,
    handlePush,
    handlePull,
    handleRemove,
  };
};
