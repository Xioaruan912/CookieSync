import { editRemotePreference } from '@sync-your-cookie/storage/lib/remotePreferences';
import { useStorageSuspense } from '@sync-your-cookie/shared';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { Popover, PopoverContent, PopoverTrigger, Switch } from '@sync-your-cookie/ui';
import { Eye, EyeOff } from 'lucide-react';
import React, { useState } from 'react';

interface SettingsPopoverProps {
  trigger: React.ReactNode;
}

type PopTab = 'rhythm' | 'scope' | 'security';

export function SettingsPopover({ trigger }: SettingsPopoverProps) {
  const settingsInfo = useStorageSuspense(settingsStorage);
  const [tab, setTab] = useState<PopTab>('rhythm');
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
      | 'backgroundSync'
      | 'activeDeviceSync',
  ) => {
    if (checkedKey === 'contextMenu') {
      void editRemotePreference('contextMenu', checked);
      return;
    }
    void settingsStorage.update({ [checkedKey]: checked });
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    void settingsStorage.update({ encryptionPassword: e.target.value });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" sideOffset={10} className="sbo-pop">
        <div className="sbo-pop-head">
          <h3 className="sbo-pop-title">高级设置</h3>
          <span className="sbo-pop-kicker">PREFERENCES</span>
        </div>

        <div className="sbo-pop-tabs" role="tablist" aria-label="高级设置分区">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'rhythm'}
            className="sbo-pop-tab"
            onClick={() => setTab('rhythm')}>
            <span className="sbo-pop-tab-num">01</span>
            <span>同步节奏</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'scope'}
            className="sbo-pop-tab"
            onClick={() => setTab('scope')}>
            <span className="sbo-pop-tab-num">02</span>
            <span>数据范围</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'security'}
            className="sbo-pop-tab"
            onClick={() => setTab('security')}>
            <span className="sbo-pop-tab-num">03</span>
            <span>隐私加密</span>
          </button>
        </div>

        <div className="sbo-pop-body" role="tabpanel">
          {tab === 'rhythm' ? (
            <>
              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="activeDeviceSync" className="sbo-pop-label">
                    双机自动交接
                  </label>
                  <span className="sbo-pop-desc">识别正在使用的电脑单主上传，离开 90 秒后静默待机</span>
                </div>
                <Switch
                  id="activeDeviceSync"
                  checked={settingsInfo.activeDeviceSync !== false}
                  onCheckedChange={checked => handleCheckChange(checked, 'activeDeviceSync')}
                />
              </div>

              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="startupPull" className="sbo-pop-label">
                    启动时自动拉取
                  </label>
                  <span className="sbo-pop-desc">打开浏览器后自动拉齐云端最新登录状态</span>
                </div>
                <Switch
                  id="startupPull"
                  checked={settingsInfo.startupPull !== false}
                  onCheckedChange={checked => handleCheckChange(checked, 'startupPull')}
                />
              </div>

              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="backgroundSync" className="sbo-pop-label">
                    后台增量同步
                  </label>
                  <span className="sbo-pop-desc">运行期间静默监听变化，双端改动时自动保留较新一侧</span>
                </div>
                <Switch
                  id="backgroundSync"
                  checked={settingsInfo.backgroundSync !== false}
                  onCheckedChange={checked => handleCheckChange(checked, 'backgroundSync')}
                />
              </div>

              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="sync-interval" className="sbo-pop-label">
                    检查间隔（分钟）
                  </label>
                  <span className="sbo-pop-desc">默认每 2 分钟合并检查一次（1–60）</span>
                </div>
                <input
                  id="sync-interval"
                  type="number"
                  min={1}
                  max={60}
                  className="sbo-pop-num-input"
                  value={settingsInfo.syncIntervalMinutes ?? 2}
                  onChange={event => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value) && value >= 1 && value <= 60) {
                      void editRemotePreference('syncIntervalMinutes', value);
                    }
                  }}
                />
              </div>
            </>
          ) : null}

          {tab === 'scope' ? (
            <>
              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="include" className="sbo-pop-label">
                    包含 LocalStorage
                  </label>
                  <span className="sbo-pop-desc">同步网站本地登录凭证与偏好，页面断连时自动注入自愈</span>
                </div>
                <Switch
                  id="include"
                  checked={settingsInfo.includeLocalStorage}
                  onCheckedChange={checked => handleCheckChange(checked, 'includeLocalStorage')}
                />
              </div>

              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="include-session" className="sbo-pop-label">
                    包含 sessionStorage
                  </label>
                  <span className="sbo-pop-desc">默认关闭；按标签页生效，也可在弹窗为单个网站开启</span>
                </div>
                <Switch
                  id="include-session"
                  checked={settingsInfo.includeSessionStorage === true}
                  onCheckedChange={checked => handleCheckChange(checked, 'includeSessionStorage')}
                />
              </div>

              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="include-idb" className="sbo-pop-label">
                    包含 IndexedDB（实验）
                  </label>
                  <span className="sbo-pop-desc">仅同步小型对象仓库，自动跳过超大缓存，默认关闭</span>
                </div>
                <Switch
                  id="include-idb"
                  checked={settingsInfo.includeIndexedDB === true}
                  onCheckedChange={checked => handleCheckChange(checked, 'includeIndexedDB')}
                />
              </div>

              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="contextMenu" className="sbo-pop-label">
                    显示右键菜单
                  </label>
                  <span className="sbo-pop-desc">在网页右键菜单中提供快速推送与拉取入口</span>
                </div>
                <Switch
                  id="contextMenu"
                  checked={settingsInfo.contextMenu}
                  onCheckedChange={checked => handleCheckChange(checked, 'contextMenu')}
                />
              </div>
            </>
          ) : null}

          {tab === 'security' ? (
            <>
              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="encoding" className="sbo-pop-label">
                    Protobuf 紧凑编码
                  </label>
                  <span className="sbo-pop-desc">大幅减小网盘体积，开启端到端加密前需保持启用</span>
                </div>
                <Switch
                  id="encoding"
                  checked={settingsInfo.protobufEncoding}
                  onCheckedChange={checked => handleCheckChange(checked, 'protobufEncoding')}
                />
              </div>

              <div className="sbo-pop-row">
                <div className="sbo-pop-row-text">
                  <label htmlFor="encryption" className="sbo-pop-label">
                    端到端加密
                  </label>
                  <span className="sbo-pop-desc">上传前使用 AES-256-GCM 加密，云端仅保存密文</span>
                </div>
                <Switch
                  id="encryption"
                  checked={settingsInfo.encryptionEnabled}
                  disabled={!settingsInfo.protobufEncoding}
                  onCheckedChange={checked => handleCheckChange(checked, 'encryptionEnabled')}
                />
              </div>

              {settingsInfo.encryptionEnabled && settingsInfo.protobufEncoding ? (
                <div className="pt-2">
                  <label htmlFor="encryptionPassword" className="sbo-pop-desc block">
                    加密密码（两台电脑需设置一致）
                  </label>
                  <div className="sbo-pop-pw-wrap">
                    <input
                      type={openEye ? 'text' : 'password'}
                      id="encryptionPassword"
                      value={settingsInfo.encryptionPassword || ''}
                      onChange={handlePasswordChange}
                      className="sbo-pop-pw-input"
                      placeholder="输入端到端加密密码"
                    />
                    <button
                      type="button"
                      className="sbo-pop-eye"
                      aria-label={openEye ? '隐藏密码' : '显示密码'}
                      onClick={() => setOpenEye(prev => !prev)}>
                      {openEye ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="sbo-pop-note">开启端到端加密后，网盘内只保存密文；加密密码仅保存在本机。</p>
              )}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
