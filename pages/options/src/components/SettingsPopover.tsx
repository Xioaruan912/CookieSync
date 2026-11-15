import { GithubApi, pullCookies, useStorageSuspense } from '@sync-your-cookie/shared';
import { accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { Input, Label, Popover, PopoverContent, PopoverTrigger, Switch, SyncTooltip } from '@sync-your-cookie/ui';
import { Eye, EyeOff, Info, Lock, SquareArrowOutUpRight } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { StorageSelect } from './StorageSelect';
interface SettingsPopover {
  trigger: React.ReactNode;
}

export function SettingsPopover({ trigger }: SettingsPopover) {
  const settingsInfo = useStorageSuspense(settingsStorage);
  const [selectOpen, setSelectOpen] = useState(false);
  const [openEye, setOpenEye] = useState(false);

  const handleCheckChange = (
    checked: boolean,
    checkedKey:
      | 'protobufEncoding'
      | 'includeLocalStorage'
      | 'contextMenu'
      | 'encryptionEnabled'
      | 'startupPull'
      | 'backgroundSync',
  ) => {
    settingsStorage.update({
      [checkedKey]: checked,
    });
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    settingsStorage.update({
      encryptionPassword: e.target.value,
    });
  };

  const handleValueChange = (value: string) => {
    settingsStorage.update({
      storageKey: value,
    });
  };

  const reset = async () => {
    await domainStatusStorage.resetState();
    await cookieStorage.reset();
    try {
      await pullCookies();
    } catch {
      /* Configuration may not be complete yet. */
    }
  };

  useEffect(() => {
    reset();
  }, [settingsInfo.storageKey]);
  const handleToggleEye = () => {
    setOpenEye(!openEye);
  };
  const handleOpenChange = (open: boolean) => {
    if (selectOpen) return;
    // if (open === false && (settingsInfo.storageKey !== storageKey || !storageKey)) {
    //   console.log('open', open);
    //   settingsStorage.update({
    //     storageKey: storageKey || defaultKey,
    //   });
    //   domainConfigStorage.resetState();
    // }
  };

  const handleSelectOpenChange = (open: boolean) => {
    setSelectOpen(open);
  };

  const handleAddStorageKey = async (key: string) => {
    const accountStorageInfo = await accountStorage.getSnapshot();
    if (accountStorageInfo?.selectedProvider === 'github') {
      const gistId = settingsInfo.storageKeyGistId;
      await GithubApi.instance.addGistFile(gistId!, key);
      await GithubApi.instance.initStorageKeyList();
    } else {
      await settingsStorage.addStorageKey(key);
    }
  };

  const handleRemoveStorageKey = async (key: string) => {
    const accountStorageInfo = await accountStorage.getSnapshot();
    if (accountStorageInfo?.selectedProvider === 'github') {
      const gistId = settingsInfo.storageKeyGistId;
      await GithubApi.instance.deleteGistFile(gistId!, key);
      await GithubApi.instance.initStorageKeyList();
    } else {
      await settingsStorage.removeStorageKey(key);
    }
  };

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] max-h-[80vh] overflow-y-auto">
        <div className="grid gap-4">
          <div className="space-y-2">
            <h3 className="leading-none font-medium text-base">高级设置</h3>
            <p className="text-muted-foreground text-sm">设置存储格式、数据范围与加密。 </p>
          </div>
          <div className="gap-2">
            <div className="mb-4 space-y-3 border-b pb-4">
              <p className="text-sm">无感同步：首次手动推送后，默认开启该网站的自动收发，可在弹窗单独关闭。</p>
              {(
                [
                  ['startupPull', '浏览器启动时自动拉取'],
                  ['backgroundSync', '运行期间后台增量同步'],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-2">
                  <Label htmlFor={key}>{label}</Label>
                  <Switch
                    id={key}
                    checked={settingsInfo[key] !== false}
                    onCheckedChange={checked => handleCheckChange(checked, key)}
                  />
                </div>
              ))}
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="sync-interval">后台同步间隔（分钟）</Label>
                <Input
                  id="sync-interval"
                  className="w-20 h-8"
                  type="number"
                  min={1}
                  max={60}
                  value={settingsInfo.syncIntervalMinutes ?? 2}
                  onChange={event => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value) && value >= 1 && value <= 60)
                      void settingsStorage.update({ syncIntervalMinutes: value });
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                默认每 2 分钟合并改动，启动时立即拉取；不依赖关闭事件，也不弹同步通知。
              </p>
            </div>
            <div className="flex items-center gap-4 mb-4">
              <Label className="w-[136px] block text-right" htmlFor="storage-key">
                <div className="flex gap-2 justify-end">
                  存储键
                  {settingsInfo.gistHtmlUrl ? (
                    <a href={settingsInfo.gistHtmlUrl} target="_blank" rel="noreferrer">
                      <SquareArrowOutUpRight size={16} />
                    </a>
                  ) : null}
                </div>
              </Label>
              {/* <Input
                onChange={handleKeyInputChange}
                id="storage-key"
                value={storageKey}
                className="h-8 flex-1"
                placeholder={defaultKey}
              /> */}
              <StorageSelect
                options={settingsInfo.storageKeyList}
                open={selectOpen}
                onOpenChange={handleSelectOpenChange}
                value={settingsInfo.storageKey || ''}
                onAdd={handleAddStorageKey}
                onRemove={handleRemoveStorageKey}
                onValueChange={handleValueChange}
              />
            </div>
            <div className="flex items-center gap-4 mb-4">
              <Label className="whitespace-nowrap block w-[136px] justify-end text-right" htmlFor="encoding">
                Protobuf 编码
              </Label>
              <Switch
                onCheckedChange={checked => handleCheckChange(checked, 'protobufEncoding')}
                checked={settingsInfo.protobufEncoding}
                id="encoding"
              />
            </div>

            <div className="flex items-center gap-4 mb-4">
              <Label
                className="items-center  whitespace-nowrap flex w-[136px] justify-end text-right"
                htmlFor="include">
                包含 LocalStorage
              </Label>
              <div className="flex items-center gap-1">
                <Switch
                  onCheckedChange={checked => handleCheckChange(checked, 'includeLocalStorage')}
                  checked={settingsInfo.includeLocalStorage}
                  id="include"
                />
                <SyncTooltip title="开启后台同步后，已启用网站会定期检测 LocalStorage 变化；首次手动读取失败时可能刷新页面重试。">
                  <Info className="mx-2" size={18} />
                </SyncTooltip>
              </div>
            </div>

            <div className="flex items-center gap-4 mb-4">
              <Label
                className="items-center whitespace-nowrap flex w-[136px] justify-end text-right"
                htmlFor="contextMenu">
                显示右键菜单
              </Label>
              <div className="flex items-center gap-1">
                <Switch
                  onCheckedChange={checked => handleCheckChange(checked, 'contextMenu')}
                  checked={settingsInfo.contextMenu}
                  id="contextMenu"
                />
              </div>
            </div>

            <div className="border-t pt-4 mt-2">
              <div className="flex items-center gap-4 mb-4">
                <Label
                  className="items-center whitespace-nowrap flex w-[136px] justify-end text-right"
                  htmlFor="encryption">
                  <Lock size={14} className="mr-1" />
                  端到端加密
                </Label>
                <div className="flex items-center gap-1">
                  <Switch
                    onCheckedChange={checked => handleCheckChange(checked, 'encryptionEnabled')}
                    checked={settingsInfo.encryptionEnabled}
                    disabled={!settingsInfo.protobufEncoding}
                    id="encryption"
                  />
                  <SyncTooltip title="需开启 Protobuf 编码。上传前使用 AES-256-GCM 加密，两台电脑须设置相同的加密密码。">
                    <Info className="mx-2" size={18} />
                  </SyncTooltip>
                </div>
              </div>

              {settingsInfo.encryptionEnabled && settingsInfo.protobufEncoding && (
                <div className="flex items-center gap-2">
                  <Label
                    className="items-center mr-2 whitespace-nowrap flex w-[136px] justify-end text-right"
                    htmlFor="encryptionPassword">
                    密码
                  </Label>
                  <Input
                    type={openEye ? 'text' : 'password'}
                    id="encryptionPassword"
                    value={settingsInfo.encryptionPassword || ''}
                    onChange={handlePasswordChange}
                    className="h-8 flex-1"
                    placeholder="输入加密密码"
                  />
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => handleToggleEye()}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        handleToggleEye();
                      }
                    }}
                    className="cursor-pointer mr-4">
                    {openEye ? <EyeOff size={18} /> : <Eye size={18} />}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
