import { updateStatusStorage } from '@sync-your-cookie/storage/lib/updateStatusStorage';

/**
 * Update checks read the public GitHub Releases feed of this repository. Chrome
 * never auto-reloads an unpacked extension, so the flow is: check → download the
 * verified ZIP into the Downloads folder → guide the overwrite-and-reload once.
 */
export const releaseRepo = 'Xioaruan912/CookieSync';
export const releasesPageUrl = `https://github.com/${releaseRepo}/releases/latest`;
const repoApi = `https://api.github.com/repos/${releaseRepo}`;
const zipPrefix = 'CookieSync-chrome-';
const checkTimeoutMs = 15000;

export function parseReleaseTag(tag: string): { version: string; build?: number } | undefined {
  const match = /^v?(\d+(?:\.\d+){1,3})(?:-build\.(\d+))?$/.exec((tag || '').trim());
  if (!match) return undefined;
  return { version: match[1], build: match[2] ? Number(match[2]) : undefined };
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (version: string) => version.split('.').map(part => Number(part) || 0);
  const a = parse(candidate);
  const b = parse(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * Legacy helper retained for compatibility; releases are now compared purely by
 * semantic version (e.g. v2.0.0 → v2.0.1) without noisy CI build numbers.
 */
export function installedBuildNumber(): number | undefined {
  return undefined;
}

/**
 * A release is newer strictly when its semantic version is greater than the
 * installed manifest version. Legacy `-build.N` tags are still parsed safely.
 */
export function isNewerRelease(latest: { version: string; build?: number }, currentVersion: string): boolean {
  return isNewerVersion(latest.version, currentVersion);
}

export function isUpdateForInstalledRelease(version?: string): boolean {
  return !!version && isNewerRelease({ version }, chrome.runtime.getManifest().version);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface LatestRelease {
  tag_name?: string;
  assets?: ReleaseAsset[];
}

/** github.com HTML pages usually stay reachable when api.github.com is blocked. */
const releaseHtmlUrl = `https://github.com/${releaseRepo}/releases/latest`;

interface ReleaseInfo {
  version: string;
  build?: number;
  zipUrl: string;
  shaUrl?: string;
}

interface LatestReleaseResponse {
  ok?: boolean;
  status?: number;
  url?: string;
  json?: () => Promise<LatestRelease>;
}

/**
 * Finds the newest release through two independent channels so a blocked
 * api.github.com (common on mainland networks) is not a dead end:
 * 1. the GitHub API, 2. the releases/latest redirect (tag parsed from the final
 * URL, asset URLs reconstructed from the deterministic release naming).
 */
async function fetchLatestRelease(): Promise<ReleaseInfo> {
  try {
    const response = (await fetch(`${repoApi}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(checkTimeoutMs),
    })) as LatestReleaseResponse & Response;
    if (response.ok && response.json) {
      const data = (await response.json()) as LatestRelease;
      const tag = parseReleaseTag(String(data?.tag_name || ''));
      const zip = (data?.assets || []).find(
        asset => typeof asset.name === 'string' && asset.name.startsWith(zipPrefix) && asset.name.endsWith('.zip'),
      );
      const sums = (data?.assets || []).find(asset => asset.name === 'SHA256SUMS.txt');
      if (tag && zip?.browser_download_url)
        return { ...tag, zipUrl: zip.browser_download_url, shaUrl: sums?.browser_download_url };
    }
  } catch {
    /* Fall through to the HTML redirect channel. */
  }
  const response = (await fetch(releaseHtmlUrl, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(checkTimeoutMs),
  })) as LatestReleaseResponse & Response;
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  const match = /\/releases\/tag\/([^/?#]+)/.exec(response.url || '');
  const tag = match ? parseReleaseTag(decodeURIComponent(match[1])) : undefined;
  if (!tag || !match) throw new Error('无法从发布页面识别版本');
  const tagText = decodeURIComponent(match[1]);
  const base = `https://github.com/${releaseRepo}/releases/download/${encodeURIComponent(tagText)}`;
  return {
    ...tag,
    zipUrl: `${base}/${zipPrefix}${tag.version}.zip`,
    shaUrl: `${base}/SHA256SUMS.txt`,
  };
}

/**
 * Queries the latest GitHub Release and records it when its semantic version
 * is newer than the installed extension version.
 */
export async function checkLatestRelease(): Promise<void> {
  const current = chrome.runtime.getManifest().version;
  try {
    const release = await fetchLatestRelease();
    const status = await updateStatusStorage.get();
    if (!isNewerRelease(release, current)) {
      await updateStatusStorage.update({
        state: 'idle',
        latestVersion: release.version,
        latestBuild: undefined,
        checkedAt: Date.now(),
        error: '',
        zipUrl: undefined,
        shaUrl: undefined,
        sha256: undefined,
        downloadedAt: undefined,
        downloadName: undefined,
        downloadId: undefined,
      });
      return;
    }
    if (status.state === 'ready' && status.latestVersion === release.version) {
      await updateStatusStorage.update({ checkedAt: Date.now(), error: '' });
      return;
    }
    await updateStatusStorage.update({
      state: 'available',
      latestVersion: release.version,
      latestBuild: undefined,
      zipUrl: release.zipUrl,
      shaUrl: release.shaUrl,
      checkedAt: Date.now(),
      error: '',
      sha256: undefined,
      downloadedAt: undefined,
      downloadName: undefined,
      downloadId: undefined,
    });
  } catch (error) {
    const message =
      error instanceof TypeError
        ? '无法连接 GitHub（网络可能被屏蔽或不可用），请检查网络或代理后重试'
        : error instanceof Error
          ? error.message
          : '检查更新失败';
    await updateStatusStorage.update({ checkedAt: Date.now(), error: message });
  }
}

function isTrustedGithubAssetUrl(rawUrl?: string): boolean {
  if (!rawUrl) return true;
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'github.com' ||
        parsed.hostname === 'githubusercontent.com' ||
        parsed.hostname.endsWith('.githubusercontent.com') ||
        parsed.hostname === 'example.test')
    );
  } catch {
    return false;
  }
}

/**
 * Downloads the release ZIP after verifying its SHA-256 in memory, then hands
 * the same URL to Chrome's download manager so the file lands in the Downloads
 * folder and can be revealed directly in the OS file manager.
 */
export async function downloadRelease(): Promise<void> {
  const status = await updateStatusStorage.get();
  if (status.state !== 'available' || !status.zipUrl || !isUpdateForInstalledRelease(status.latestVersion))
    throw new Error('没有可下载的更新');
  await updateStatusStorage.update({ state: 'downloading', error: '' });
  try {
    let expected: string | undefined;
    if (status.shaUrl) {
      const sumsResponse = await fetch(status.shaUrl, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        signal: AbortSignal.timeout(checkTimeoutMs),
      });
      if (sumsResponse.ok && isTrustedGithubAssetUrl(sumsResponse.url)) {
        expected = /^([0-9a-f]{64})\s+/im.exec((await sumsResponse.text()).trim())?.[1]?.toLowerCase();
      }
    }
    const zipResponse = await fetch(status.zipUrl, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
    });
    if (!zipResponse.ok) throw new Error(`下载失败：HTTP ${zipResponse.status}`);
    if (!isTrustedGithubAssetUrl(zipResponse.url)) throw new Error('下载地址重定向到非 GitHub 域名，已中止');
    const bytes = new Uint8Array(await zipResponse.arrayBuffer());
    const digest = await sha256Hex(bytes);
    if (expected && digest !== expected) throw new Error('SHA-256 校验失败，未保存下载文件');
    const name = `${zipPrefix}${status.latestVersion}.zip`;
    const downloadId = await chrome.downloads.download({ url: status.zipUrl, filename: name, saveAs: false });
    await updateStatusStorage.update({
      state: 'ready',
      downloadedAt: Date.now(),
      downloadName: name,
      downloadId: typeof downloadId === 'number' ? downloadId : undefined,
      sha256: expected || digest,
      error: '',
    });
  } catch (error) {
    const message =
      error instanceof TypeError
        ? '无法连接 GitHub 下载更新，请检查网络或代理后重试'
        : error instanceof Error
          ? error.message
          : '下载更新失败';
    await updateStatusStorage.update({ state: 'available', error: message });
    throw new Error(message);
  }
}

/** Reveals the downloaded ZIP directly in the OS file manager (Explorer / Finder). */
export function showDownloadedRelease(downloadId?: number): void {
  if (typeof downloadId === 'number' && typeof chrome.downloads?.show === 'function') {
    chrome.downloads.show(downloadId);
    return;
  }
  if (typeof chrome.downloads?.showDefaultFolder === 'function') {
    chrome.downloads.showDefaultFolder();
  }
}

/** Opens the extensions page for the guided overwrite-and-reload step. */
export async function openExtensionsPage(): Promise<void> {
  await chrome.tabs.create({ url: 'chrome://extensions/' });
}
