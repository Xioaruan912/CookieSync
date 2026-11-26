import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';
import { useEffect, useState } from 'react';
import { getTabsByHost, refreshCookiesUsingMessage, useStorageSuspense } from '@sync-your-cookie/shared';
import {
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Image,
  Spinner,
  Switch,
} from '@sync-your-cookie/ui';
import {
  ArrowUpRight,
  ChevronLeft,
  ClipboardList,
  CloudDownload,
  CloudUpload,
  Copy,
  Ellipsis,
  RotateCw,
  Table as TableIcon,
  Trash,
} from 'lucide-react';

import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';

import { useAction } from './hooks/useAction';
import { SearchInput } from './SearchInput';

export type CookieItem = {
  id: string;
  host: string;
  sourceUrl?: string;
  favIconUrl?: string;
  autoPush: boolean;
  autoPull: boolean;
  cookieCount: number;
  storageCount: number;
  createTime: number;
};

const CookieTable = () => {
  const domainConfig = useStorageSuspense(domainConfigStorage);
  const domainStatus = useStorageSuspense(domainStatusStorage);
  const cookieMap = useStorageSuspense(cookieStorage);
  const feedback = useStorageSuspense(syncFeedbackStorage);
  const [refreshing, setRefreshing] = useState(false);
  const [readError, setReadError] = useState('');

  const refresh = async () => {
    setRefreshing(true);
    setReadError('');
    try {
      await refreshCookiesUsingMessage();
    } catch (error) {
      setReadError(
        (error as { msg?: string; message?: string })?.msg || (error as Error)?.message || '远程列表读取失败',
      );
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const {
    showCookiesColumns,
    cookieList,
    handleBack,
    setSelectedDomain,
    selectedDomain,
    loading,
    cookieAction,
    handleDelete,
    handlePush,
    handlePull,
    handleCopy,
    handleViewCookies,
    handleSearch,
    currentSearchStr,
    hasLocalStorage,
    localStorageMode,
    setLocalStorageMode,
    showLocalStorageColumns,
    localStorageItems,
  } = useAction(cookieMap);

  let totalCookieItem = 0;
  let totalLocalStorageItem = 0;
  const domainList: CookieItem[] = [];

  for (const [key, value] of Object.entries(cookieMap?.domainCookieMap || {})) {
    const config = domainConfig.domainMap[key];
    const cookieCount = value.cookies?.length || 0;
    const storageCount =
      (value.localStorageItems?.length || 0) +
      (value.sessionStorageItems?.length || 0) +
      (value.indexedDBRecords?.length || 0);
    totalCookieItem += cookieCount;
    totalLocalStorageItem += storageCount;
    domainList.push({
      id: key,
      host: key,
      sourceUrl: config?.sourceUrl,
      favIconUrl: config?.favIconUrl,
      autoPush: config?.autoPush ?? true,
      autoPull: config?.autoPull ?? true,
      cookieCount,
      storageCount,
      createTime: value.createTime || 0,
    });
  }

  domainList.sort((a, b) => b.createTime - a.createTime);

  const visibleSites = domainList.filter(
    site => selectedDomain || site.host.toLowerCase().includes(currentSearchStr.trim().toLowerCase()),
  );

  const handleAndCheckPushCookie = async (row: CookieItem) => {
    const protocol = row.sourceUrl ? new URL(row.sourceUrl).protocol : 'https:';
    const href = `${protocol}//${row.host}`;
    const includeLocalStorage = settingsStorage.getSnapshot()?.includeLocalStorage;
    if (includeLocalStorage) {
      const matchedTabs = await getTabsByHost(row.host);
      if (matchedTabs.length === 0) {
        window.open(href, '_blank');
        setTimeout(() => {
          void handlePush(row, href);
        }, 500);
      } else {
        void handlePush(row, href);
      }
    } else {
      void handlePush(row, href);
    }
  };

  const selectedRow = domainConfig.domainMap[selectedDomain];
  const selectedProtocol = selectedRow?.sourceUrl ? new URL(selectedRow.sourceUrl).protocol : 'https:';
  const selectedHref = `${selectedProtocol}//${selectedDomain}`;

  return (
    <div className="flex h-full flex-col">
      <header className="sp-header">
        <h2 className="sp-title">同步管理</h2>
        <button
          type="button"
          className="sp-pill-btn"
          onClick={() => void refresh()}
          disabled={refreshing || domainStatus.pushing}>
          <RotateCw size={13} className={refreshing ? 'animate-spin' : ''} aria-hidden />
          {refreshing ? '读取中…' : '刷新远程'}
        </button>
      </header>

      {feedback.lastPush && !feedback.lastPush.ok ? (
        <div role="alert" className="sp-alert">
          最近推送未成功（{feedback.lastPush.host}）：{feedback.lastPush.message}
        </div>
      ) : null}

      {readError ? (
        <p role="alert" className="sp-alert">
          远程列表未加载：{readError}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <Spinner show={loading}>
          {selectedDomain ? (
            <div className="flex h-full flex-col">
              <div className="sp-detail-head">
                <div className="flex min-w-0 items-center gap-2.5">
                  <button type="button" className="sp-back-btn" onClick={() => handleBack()} aria-label="返回列表">
                    <ChevronLeft size={15} aria-hidden />
                  </button>
                  <a
                    href={selectedHref}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:underline">
                    {selectedRow?.favIconUrl ? <Image src={selectedRow.favIconUrl} /> : null}
                    <span className="truncate">{selectedDomain}</span>
                  </a>
                </div>
                {hasLocalStorage ? (
                  <button
                    type="button"
                    className="sp-mode-pill"
                    aria-pressed={localStorageMode}
                    onClick={() => setLocalStorageMode(!localStorageMode)}>
                    {localStorageMode ? '查看 Cookie' : '查看存储'}
                  </button>
                ) : null}
              </div>
              <div className="sp-search-wrap">
                <SearchInput
                  key={selectedDomain}
                  onEnter={handleSearch}
                  label={localStorageMode ? '搜索存储项…' : '搜索 Cookie…'}
                />
              </div>
              <div className="sp-list">
                {localStorageMode ? (
                  <DataTable columns={showLocalStorageColumns as any} data={localStorageItems} />
                ) : (
                  <DataTable columns={showCookiesColumns} data={cookieList} />
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <dl className="sp-metrics">
                <div className="sp-metric">
                  <dt>网站</dt>
                  <dd>{domainList.length}</dd>
                </div>
                <div className="sp-metric">
                  <dt>Cookie</dt>
                  <dd>{totalCookieItem}</dd>
                </div>
                <div className="sp-metric">
                  <dt>存储项</dt>
                  <dd>{totalLocalStorageItem}</dd>
                </div>
              </dl>

              <div className="sp-search-wrap">
                <SearchInput key="sites" onEnter={handleSearch} label="搜索网站域名…" />
              </div>

              <div className="sp-list">
                {!domainList.length && !refreshing ? (
                  <p className="sp-empty">
                    {readError ? '暂时无法确认远程网站数量，请检查设置后刷新。' : '当前列表暂无网站数据。'}
                  </p>
                ) : domainList.length > 0 && visibleSites.length === 0 ? (
                  <p role="status" className="sp-empty">
                    没有匹配的网站
                  </p>
                ) : (
                  visibleSites.map((row, idx) => {
                    const itemStatus = cookieAction.getDomainItemStatus(row.host) || {};
                    const protocol = row.sourceUrl ? new URL(row.sourceUrl).protocol : 'https:';
                    const href = `${protocol}//${row.host}`;
                    const src = row.favIconUrl ?? `https://${row.host}/favicon.ico`;
                    const disabled = itemStatus.pushing || cookieAction.pushing;

                    return (
                      <div key={row.host} className="sp-site-row">
                        <div className="sp-site-top">
                          <button
                            type="button"
                            className="sp-site-btn"
                            onClick={() => {
                              handleSearch('');
                              setSelectedDomain(row.host);
                            }}>
                            <Image key={row.host} index={idx} src={src} value={row.host} />
                            <span className="sp-site-host">{row.host}</span>
                          </button>

                          <div className="sp-site-tools">
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`打开 ${row.host}`}
                              className="sp-icon-link">
                              <ArrowUpRight size={14} aria-hidden />
                            </a>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button type="button" className="sp-icon-link" aria-label={`更多操作 ${row.host}`}>
                                  <Ellipsis size={15} aria-hidden />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>{row.host}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="cursor-pointer"
                                  disabled={disabled}
                                  onClick={() => void handleAndCheckPushCookie(row)}>
                                  {itemStatus.pushing ? (
                                    <RotateCw size={15} className="mr-2 animate-spin" />
                                  ) : (
                                    <CloudUpload size={15} className="mr-2" />
                                  )}
                                  推送到云端
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="cursor-pointer"
                                  disabled={itemStatus.pulling}
                                  onClick={() => handlePull(href, row)}>
                                  {itemStatus.pulling ? (
                                    <RotateCw size={15} className="mr-2 animate-spin" />
                                  ) : (
                                    <CloudDownload size={15} className="mr-2" />
                                  )}
                                  拉取到本机
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="cursor-pointer" onClick={() => handleViewCookies(row.host)}>
                                  <TableIcon size={15} className="mr-2" />
                                  查看详情
                                </DropdownMenuItem>
                                <DropdownMenuItem className="cursor-pointer" onClick={() => handleCopy(row.host)}>
                                  <Copy size={15} className="mr-2" />
                                  复制 Cookie
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="cursor-pointer"
                                  onClick={() => handleCopy(row.host, true)}>
                                  <ClipboardList size={15} className="mr-2" />
                                  复制为 JSON
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  disabled={domainStatus.pushing}
                                  className="cursor-pointer text-destructive"
                                  onClick={() => handleDelete(row)}>
                                  <Trash size={15} className="mr-2" />
                                  删除云端记录
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>

                        <div className="sp-site-bottom">
                          <span className="sp-site-counts">
                            {row.cookieCount} Cookie · {row.storageCount} 存储
                          </span>
                          <div className="sp-site-toggles">
                            <label className="sp-mini-switch">
                              <span>推送</span>
                              <Switch
                                className="scale-75 origin-right"
                                id={`autoPush-${row.host}`}
                                checked={row.autoPush}
                                aria-label={`${row.host} 自动推送`}
                                onCheckedChange={checked =>
                                  void domainConfigStorage.toggleAutoPushState(row.host, checked)
                                }
                              />
                            </label>
                            <label className="sp-mini-switch">
                              <span>拉取</span>
                              <Switch
                                className="scale-75 origin-right"
                                id={`autoPull-${row.host}`}
                                checked={row.autoPull}
                                aria-label={`${row.host} 自动拉取`}
                                onCheckedChange={checked =>
                                  void domainConfigStorage.toggleAutoPullState(row.host, checked)
                                }
                              />
                            </label>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </Spinner>
      </div>
    </div>
  );
};

export default CookieTable;
