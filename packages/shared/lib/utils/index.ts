import { WriteResponse } from '@lib/cookie/withRemote';
import { MessageErrorCode, SendResponse } from '@lib/message';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';

export function debounce<T = unknown>(func: (...args: T[]) => void, timeout = 300) {
  let timer: number | null | NodeJS.Timeout = null;
  return (...args: T[]) => {
    timer && clearTimeout(timer);
    timer = setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      func.apply(this, args);
    }, timeout);
  };
}

const successSceneMap = {
  push: '推送',
  pull: '拉取',
  remove: '移除',
  delete: '删除',
  edit: '编辑',
};

export function checkResponseAndCallback(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res: WriteResponse | Error | any,
  scene: 'push' | 'pull' | 'remove' | 'delete' | 'edit',
  callback: (response?: SendResponse) => void,
) {
  if ((res as WriteResponse)?.success) {
    callback({ isOk: true, msg: `${successSceneMap[scene]}成功` });
  } else {
    const message = res?.message || res?.msg;
    const defaultErrMsg = message ? message : `${successSceneMap[scene]}失败，请重试`;
    callback({ isOk: false, code: res?.code, msg: defaultErrMsg, result: res });
  }
}

function addProtocol(uri: string) {
  return uri.startsWith('http') ? uri : `http://${uri}`;
}

export async function extractDomainAndPort(url: string, isRemoveWWW = true): Promise<[string, string, string]> {
  let urlObj: URL;
  try {
    const maybeValidUrl = addProtocol(url);
    urlObj = new URL(maybeValidUrl);
  } catch (error) {
    return [url, '', url];
  }
  let hostname = urlObj.hostname;
  const port = urlObj.port;
  hostname = hostname.replace('http://', '').replace('https://', '');
  if (isRemoveWWW) {
    hostname = hostname.replace('www.', '');
  }
  // match ip address
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return [hostname, port, hostname];
  }
  if (hostname.split('.').length <= 2) {
    return [hostname, port, hostname];
  }
  const includeLocalStorage = settingsStorage.getSnapshot()?.includeLocalStorage;
  if (includeLocalStorage) {
    return [hostname, port, hostname];
  }

  return new Promise(resolve => {
    try {
      chrome.cookies.getAll(
        {
          url,
        },
        async cookies => {
          if (cookies) {
            const hasHostCookie = cookies.find(item => item.domain.includes(hostname));
            if (hasHostCookie) {
              resolve([hostname, port, hostname]);
            } else {
              const domain = cookies[0].domain;
              if (domain.startsWith('.')) {
                resolve([domain.slice(1), port, hostname]);
              } else {
                resolve([domain, port, hostname]);
              }
            }
          } else {
            resolve([hostname, port, hostname]);
          }
        },
      );
    } catch (error) {
      resolve([hostname, port, hostname]);
    }
  });
}
