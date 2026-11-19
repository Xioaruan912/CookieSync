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
 * The build number embedded in the manifest at CI time. Local builds have no
 * build number, which counts as unknown: a same-version release then offers
 * one update so pre-build-number installs can still reach newer code.
 */
export function installedBuildNumber(): number | undefined {
  const versionName = chrome.runtime.getManifest().version_name as string | undefined;
  const match = /build[.\s]*(\d+)/i.exec(versionName || '');
  return match ? Number(match[1]) : undefined;
}

/**
 * A release is newer when the semantic version increased, or when the version
 * matches but the build number is newer. Every main push publishes a build, so
 * same-version build bumps are real code changes and must be offered.
 */
export function isNewerRelease(
  latest: { version: string; build?: number },
  currentVersion: string,
  currentBuild?: number,
): boolean {
  if (isNewerVersion(latest.version, currentVersion)) return true;
  if (isNewerVersion(currentVersion, latest.version)) return false;
  if (latest.build === undefined) return false;
  return currentBuild === undefined || latest.build > currentBuild;
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

/**
 * Queries the latest release and records it. A newer semantic version OR a
 * newer build number of the same version counts as an update; the installed
 * build comes from the manifest's version_name embedded at CI time.
 */
export async function checkLatestRelease(): Promise<void> {
  const current = chrome.runtime.getManifest().version;
  const currentBuild = installedBuildNumber();
  try {
    const response = await fetch(`${repoApi}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(checkTimeoutMs),
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const data = (await response.json()) as LatestRelease;
    const tag = parseReleaseTag(String(data.tag_name || ''));
    if (!tag) throw new Error('发布标签格式无法识别');
    const zip = (data.assets || []).find(
      asset => typeof asset.name === 'string' && asset.name.startsWith(zipPrefix) && asset.name.endsWith('.zip'),
    );
    const sums = (data.assets || []).find(asset => asset.name === 'SHA256SUMS.txt');
    if (!zip?.browser_download_url) throw new Error('发布中未找到安装 ZIP');

    const status = await updateStatusStorage.get();
    if (!isNewerRelease(tag, current, currentBuild)) {
      // Nothing newer than what is installed; any guided-download state is moot.
      await updateStatusStorage.update({
        state: 'idle',
        latestVersion: tag.version,
        latestBuild: tag.build,
        checkedAt: Date.now(),
        error: '',
        downloadedAt: undefined,
        downloadName: undefined,
      });
      return;
    }
    // Already downloaded this exact release: keep the guided update state.
    if (status.state === 'ready' && status.latestVersion === tag.version && status.latestBuild === tag.build) {
      await updateStatusStorage.update({ checkedAt: Date.now(), error: '' });
      return;
    }
    await updateStatusStorage.update({
      state: 'available',
      latestVersion: tag.version,
      latestBuild: tag.build,
      zipUrl: zip.browser_download_url,
      shaUrl: sums?.browser_download_url,
      checkedAt: Date.now(),
      error: '',
      // A newer release invalidates any previous guided download.
      downloadedAt: undefined,
      downloadName: undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '检查更新失败';
    await updateStatusStorage.update({ checkedAt: Date.now(), error: message });
  }
}

/**
 * Downloads the release ZIP after verifying its SHA-256 in memory, then hands
 * the same URL to Chrome's download manager so the file lands in the Downloads
 * folder with the browser's own progress UI.
 */
export async function downloadRelease(): Promise<void> {
  const status = await updateStatusStorage.get();
  if (status.state !== 'available' || !status.zipUrl) throw new Error('没有可下载的更新');
  await updateStatusStorage.update({ state: 'downloading', error: '' });
  try {
    let expected: string | undefined;
    if (status.shaUrl) {
      const sumsResponse = await fetch(status.shaUrl, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(checkTimeoutMs),
      });
      if (sumsResponse.ok) {
        expected = /^([0-9a-f]{64})\s+/im.exec((await sumsResponse.text()).trim())?.[1]?.toLowerCase();
      }
    }
    const zipResponse = await fetch(status.zipUrl, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
    if (!zipResponse.ok) throw new Error(`下载失败：HTTP ${zipResponse.status}`);
    const bytes = new Uint8Array(await zipResponse.arrayBuffer());
    const digest = await sha256Hex(bytes);
    if (expected && digest !== expected) throw new Error('SHA-256 校验失败，未保存下载文件');
    const name = `${zipPrefix}${status.latestVersion}.zip`;
    await chrome.downloads.download({ url: status.zipUrl, filename: name, saveAs: false });
    await updateStatusStorage.update({
      state: 'ready',
      downloadedAt: Date.now(),
      downloadName: name,
      sha256: expected || digest,
      error: '',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '下载更新失败';
    await updateStatusStorage.update({ state: 'available', error: message });
    throw new Error(message);
  }
}

/** Opens the extensions page for the guided overwrite-and-reload step. */
export async function openExtensionsPage(): Promise<void> {
  await chrome.tabs.create({ url: 'chrome://extensions/' });
}
