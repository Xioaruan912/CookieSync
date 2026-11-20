import { editRemotePreference } from '@sync-your-cookie/storage/lib/remotePreferences';
import { useStorageSuspense } from '@sync-your-cookie/shared';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { Input, Label, Popover, PopoverContent, PopoverTrigger, Switch, SyncTooltip } from '@sync-your-cookie/ui';
import { Eye, EyeOff, Info, Lock } from 'lucide-react';
import React, { useState } from 'react';

interface SettingsPopoverProps {
  trigger: React.ReactNode;
}

export function SettingsPopover({ trigger }: SettingsPopoverProps) {
  const settingsInfo = useStorageSuspense(settingsStorage);
  const [openEye, setOpenEye] = useState(false);

  const handleCheckChange = (
    checked: boolean,
    checkedKey:
      | 'protobufEncoding'
      | 'includeLocalStorage'
      | 'includeSessionStorage'
      | 'includeIndexedDB'
      | 'contextMenu'
      | 'encryptionEnabled'
      | 'startupPull'
      | 'backgroundSync',
  ) => {
    if (checkedKey === 'contextMenu') {
      void editRemotePreference('contextMenu', checked);
      return;
    }
    settingsStorage.update({
      [checkedKey]: checked,
    });
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    settingsStorage.update({
      encryptionPassword: e.target.value,
    });
  };

  const handleToggleEye = () => {
    setOpenEye(!openEye);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] max-h-[80vh] overflow-y-auto">
        <div className="grid gap-4">
          <div className="space-y-2">
            <h3 className="leading-none font-medium text-base">高级设置</h3>
            <p className="text-muted-foreground text-sm">设置同步节奏、数据范围与加密。</p>
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
                      void editRemotePreference('syncIntervalMinutes', value);
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                默认每 2 分钟合并改动，启动时立即拉取；两端同时变化时保留较新一侧。
              </p>
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
                className="items-center whitespace-nowrap flex w-[136px] justify-end text-right"
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

            <div className="flex items-start gap-4 mb-4">
              <Label
                className="items-center whitespace-nowrap flex w-[136px] justify-end text-right pt-0.5"
                htmlFor="include-session">
                包含 sessionStorage
              </Label>
              <div className="flex items-start gap-1">
                <Switch
                  onCheckedChange={checked => handleCheckChange(checked, 'includeSessionStorage')}
                  checked={settingsInfo.includeSessionStorage === true}
                  id="include-session"
                />
                <SyncTooltip title="默认关闭：部分单页应用把会话状态放在 sessionStorage，开启后才能随同步走。它是逐标签页状态，敏感站点可能因为易变值增加上传次数；可在弹窗为单个网站单独开启。恢复时会刷新该网站页面一次。">
                  <Info className="mx-2 mt-1" size={18} />
                </SyncTooltip>
              </div>
            </div>

            <div className="flex items-start gap-4 mb-4">
              <Label
                className="items-center whitespace-nowrap flex w-[136px] justify-end text-right pt-0.5"
                htmlFor="include-idb">
                包含 IndexedDB
              </Label>
              <div className="flex items-start gap-1">
                <Switch
                  onCheckedChange={checked => handleCheckChange(checked, 'includeIndexedDB')}
                  checked={settingsInfo.includeIndexedDB === true}
                  id="include-idb"
                />
                <SyncTooltip title="实验性。只同步体积较小的对象仓库（每库 ≤ 16 KB 级数据、每站点 ≤ 512 KB），跳过无法无损编码的值与超大仓库；恢复前要求页面已存在同名数据库，并会清空该仓库后重写。默认关闭；可在弹窗为单个网站开启。">
                  <Info className="mx-2 mt-1" size={18} />
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
