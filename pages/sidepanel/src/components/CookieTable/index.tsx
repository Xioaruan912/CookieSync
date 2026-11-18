import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';
import { useEffect, useState } from 'react';
/* eslint-disable react/no-unescaped-entities */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { getTabsByHost, refreshCookiesUsingMessage, useStorageSuspense } from '@sync-your-cookie/shared';
import {
  Button,
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
  SyncTooltip,
  Toggle,
} from '@sync-your-cookie/ui';
import {
  ArrowUpRight,
  ChevronLeft,
  ClipboardList,
  CloudDownload,
  CloudUpload,
  Copy,
  Database,
  Ellipsis,
  Info,
  RotateCw,
  Table as TableIcon,
  Trash,
} from 'lucide-react';

import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';

import type { ColumnDef } from '@sync-your-cookie/ui';
import { useAction } from './hooks/useAction';
import { SearchInput } from './SearchInput';
export type CookieItem = {
  id: string;
  host: string;
  sourceUrl?: string;
  favIconUrl?: string;
  autoPush: boolean;
  autoPull: boolean;
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
  let domainList = [];
  let totalCookieItem = 0;
  let totalLocalStorageItem = 0;
  for (const [key, value] of Object.entries(cookieMap?.domainCookieMap || {})) {
    const config = domainConfig.domainMap[key];

    if (value.cookies?.length) {
      totalCookieItem += value.cookies.length;
    }
    if (value.localStorageItems?.length) {
      totalLocalStorageItem += value.localStorageItems.length;
    }
    domainList.push({
      id: key,
      host: key,
      sourceUrl: config?.sourceUrl,
      favIconUrl: config?.favIconUrl,
      list: value.cookies,
      autoPush: config?.autoPush ?? true,
      autoPull: config?.autoPull ?? true,
      createTime: value.createTime,
    });
  }
  domainList = domainList.sort((a, b) => {
    return b.createTime - a.createTime;
  });

  const visibleSites = domainList.filter(
    site => selectedDomain || site.host.includes(currentSearchStr.trim().toLowerCase()),
  );

  const handleAndCheckPushCookie = async (row: CookieItem) => {
    const protocol = row.sourceUrl ? new URL(row.sourceUrl).protocol : 'https:';
    const href = `${protocol}//${row.host}`;
    const includeLocalStorage = settingsStorage.getSnapshot()?.includeLocalStorage;
    if (includeLocalStorage) {
      const matchedTabs = await getTabsByHost(row.host);
      if (matchedTabs.length === 0) {
        window.open(href, '_blank');
        setTimeout(async () => {
          handlePush(row, href);
        }, 500);
      } else {
        handlePush(row, href);
      }
    } else {
      handlePush(row, href);
    }
    // console.log('handleAndCheckPushCookie->row', row);
  };

  const columns: ColumnDef<CookieItem>[] = [
    {
      accessorKey: 'host',
      header: '网站',
      cell: ({ row, getValue }) => {
        const value = getValue<string>() || '';
        const sourceUrl = row.original.sourceUrl;
        const protocol = sourceUrl ? new URL(sourceUrl).protocol : 'https:';
        const href = `${protocol}//${row.original.host}`;
        const src = row.original.favIconUrl ?? `https://${row.original.host}/favicon.ico`;
        return (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex min-w-0 items-center text-left hover:underline"
              onClick={() => {
                handleSearch('');
                setSelectedDomain(value);
              }}>
              <Image key={row.original.host} index={row.index} src={src} value={value} />
              <span className="break-all font-medium">{value}</span>
            </button>
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              aria-label={`打开 ${value}`}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent">
              <ArrowUpRight size={14} aria-hidden />
            </a>
          </div>
        );
      },
      id: 'host',
    },
    {
      accessorKey: 'autoPush',
      header: '自动推送',
      id: 'autoPush',
      cell: record => {
        return (
          <p className="w-10">
            <Switch
              className="scale-75"
              id={`autoPush-${record.row.original.host}`}
              checked={record.row.original.autoPush}
              aria-label={`${record.row.original.host} 自动推送`}
              onCheckedChange={checked =>
                void domainConfigStorage.toggleAutoPushState(record.row.original.host, checked)
              }
            />
          </p>
        );
      },
    },
    {
      accessorKey: 'autoPull',
      header: '自动拉取',
      id: 'autoPull',
      cell: record => {
        return (
          <p className="w-10">
            <Switch
              className="scale-75"
              id={`autoPull-${record.row.original.host}`}
              checked={record.row.original.autoPull}
              aria-label={`${record.row.original.host} 自动拉取`}
              onCheckedChange={checked =>
                void domainConfigStorage.toggleAutoPullState(record.row.original.host, checked)
              }
            />
          </p>
        );
      },
    },
    {
      id: 'actions',
      enableHiding: false,
      cell: ({ row }) => {
        const itemStatus = cookieAction.getDomainItemStatus(row.original.host) || {};
        const sourceUrl = row.original.sourceUrl;
        const protocol = sourceUrl ? new URL(sourceUrl).protocol : 'http:';
        const href = `${protocol}//${row.original.host}`;
        const disabled = itemStatus.pushing || cookieAction.pushing;

        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 p-0">
                <span className="sr-only">打开菜单</span>
                <Ellipsis className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Cookie 操作</DropdownMenuLabel>
              {/* <DropdownMenuItem onClick={() => navigator.clipboard.writeText(.id)}>
                Copy payment ID
              </DropdownMenuItem> */}
              <DropdownMenuSeparator />

              <DropdownMenuItem
                className="cursor-pointer flex items-center"
                disabled={disabled}
                onClick={() => {
                  handleAndCheckPushCookie(row.original);
                }}>
                {itemStatus.pushing ? (
                  <RotateCw size={16} className=" h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <CloudUpload size={16} className="mr-2 h-4 w-4" />
                )}
                推送
                <SyncTooltip
                  align="start"
                  alignOffset={80}
                  title={
                    <p>
                      <p>If '包含 LocalStorage' is enabled and no 'host' tab is present,</p>将自动打开该网站 页面。
                    </p>
                  }>
                  <p className="text-base flex items-center font-medium">
                    <Info className="ml-14" size={16} />
                  </p>
                </SyncTooltip>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                disabled={itemStatus.pulling}
                onClick={() => {
                  handlePull(href, row.original);
                }}>
                {itemStatus.pulling ? (
                  <RotateCw size={16} className=" h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <CloudDownload size={16} className="mr-2 h-4 w-4" />
                )}
                拉取
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => {
                  handleViewCookies(row.original.host);
                }}>
                <TableIcon size={16} className="mr-2 h-4 w-4" />
                查看
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => {
                  handleCopy(row.original.host);
                }}>
                <Copy size={16} className="mr-2 h-4 w-4" />
                复制
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => {
                  handleCopy(row.original.host, true);
                }}>
                <ClipboardList size={16} className="mr-2 h-4 w-4" />
                复制为 JSON
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={domainStatus.pushing}
                className="cursor-pointer"
                onClick={() => handleDelete(row.original)}>
                {itemStatus.pulling ? (
                  <RotateCw size={16} className=" h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash size={16} className="mr-2 h-4 w-4" />
                )}
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];
  const selectedRow = domainConfig.domainMap[selectedDomain];
  const sourceUrl = selectedRow?.sourceUrl;
  const protocol = sourceUrl ? new URL(sourceUrl).protocol : 'https:';
  const href = `${protocol}//${selectedDomain}`;
  const handlePressChange = (pressed: boolean) => {
    setLocalStorageMode(pressed);
  };
  const renderTable = () => {
    return (
      <div className="flex flex-col h-full ">
        <div className="flex justify-between px-4 mb-4 ">
          <div className="flex items-center ">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 mr-2"
              onClick={() => {
                handleBack();
              }}>
              <ChevronLeft className="h-4 w-4" />
              <span className="sr-only">返回</span>
            </Button>
            <a
              href={href}
              target="_blank"
              className=" flex text-xl items-center font-semibold hover:underline "
              rel="noreferrer">
              {selectedRow?.favIconUrl ? <Image src={selectedRow?.favIconUrl} /> : null}
              {selectedDomain}
            </a>
          </div>
          {hasLocalStorage ? (
            <SyncTooltip title="切换 LocalStorage 视图">
              <Toggle pressed={localStorageMode} onPressedChange={handlePressChange} className="ml-6" variant="outline">
                <Database size={16} className="h-4 w-4" />
              </Toggle>
            </SyncTooltip>
          ) : null}
        </div>
        <div className="mb-1 px-4">
          <SearchInput
            key={selectedDomain}
            onEnter={handleSearch}
            label={localStorageMode ? '搜索存储项' : '搜索 Cookie'}
          />
        </div>
        <div className="flex-1 pl-4 pr-2 mt-4 overflow-auto">
          {localStorageMode ? (
            <DataTable columns={showLocalStorageColumns as any} data={localStorageItems} />
          ) : (
            <DataTable columns={showCookiesColumns} data={cookieList} />
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="h-screen flex flex-col bg-background">
      <div className="px-4 py-4 border-b mb-3 bg-card">
        <div>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-bold tracking-tight">同步管理</h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={refreshing || domainStatus.pushing}>
              <RotateCw size={14} className={refreshing ? 'mr-1 animate-spin' : 'mr-1'} />
              {refreshing ? '正在读取…' : '刷新远程列表'}
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">查看网站备份与同步操作</p>
        </div>
      </div>
      {feedback.lastPush && !feedback.lastPush.ok ? (
        <div role="alert" className="mx-4 mb-3 rounded border border-destructive/40 p-3 text-sm text-destructive">
          最近一次推送未成功（{feedback.lastPush.host}）：{feedback.lastPush.message}
          <p className="mt-1 text-xs">下方是本机已加载的数据；显示 0 不代表远程文件为空。</p>
        </div>
      ) : null}
      {readError ? (
        <p role="alert" className="mx-4 mb-3 text-sm text-destructive">
          远程列表未加载：{readError}
        </p>
      ) : null}
      {!domainList.length && !refreshing ? (
        <p className="mx-4 mb-3 text-sm text-muted-foreground">
          {readError
            ? '暂时无法确认远程网站数量，请检查设置后刷新。'
            : '当前列表暂无网站数据。请确认推送成功，或刷新远程列表。'}
        </p>
      ) : null}
      <div className="h-0 flex-1 overflow-auto">
        <Spinner show={loading}>
          {selectedDomain ? (
            <>{renderTable()}</>
          ) : (
            <div className="flex flex-col h-full">
              <dl className="mx-4 mb-3 grid grid-cols-3 gap-1.5 rounded-xl border bg-card p-2">
                {[
                  [domainList.length, '网站'],
                  [totalCookieItem, 'Cookie'],
                  [totalLocalStorageItem, 'LocalStorage'],
                ].map(([count, label]) => (
                  <div key={label} className="min-w-0 rounded-lg bg-muted px-2 py-2">
                    <dt className="break-words text-[11px] text-muted-foreground">{label}</dt>
                    <dd className="text-lg font-semibold tabular-nums">{count}</dd>
                  </div>
                ))}
              </dl>
              <div className="px-4">
                <SearchInput key="sites" onEnter={handleSearch} label="搜索网站域名" />
              </div>
              <div className="flex-1 overflow-auto my-4 pl-4 pr-1">
                {domainList.length > 0 && visibleSites.length === 0 ? (
                  <p role="status" className="rounded-lg border bg-card p-3 text-sm text-muted-foreground">
                    没有匹配的网站
                  </p>
                ) : (
                  <DataTable columns={columns} data={visibleSites} />
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
