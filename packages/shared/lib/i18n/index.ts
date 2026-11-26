import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { useStorageSuspense } from '../hooks';

export type LanguageSetting = 'auto' | 'zh' | 'en';
export type Locale = 'zh' | 'en';

export function detectBrowserLocale(): Locale {
  try {
    const raw =
      (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage?.()) ||
      (typeof navigator !== 'undefined' && navigator.language) ||
      'zh';
    return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

export function resolveLocale(setting?: LanguageSetting): Locale {
  if (setting === 'zh' || setting === 'en') return setting;
  return detectBrowserLocale();
}

export function useLocale() {
  const settings = useStorageSuspense(settingsStorage);
  const setting: LanguageSetting = settings.language || 'auto';
  const locale = resolveLocale(setting);
  const isEn = locale === 'en';
  const t = (zh: string, en: string) => (isEn ? en : zh);
  const setLanguage = (language: LanguageSetting) => settingsStorage.update({ language });
  const toggleLanguage = () => setLanguage(isEn ? 'zh' : 'en');
  return { locale, setting, isEn, t, setLanguage, toggleLanguage };
}
