// The app's name since 2026-10-16 (it was Evenly 分帳; the code, the repo and the storage keys
// still say evenly). Chinese pages print the Chinese name, English pages the English one.
// index.html and public/manifest.webmanifest repeat it as text.

export const APP_NAME_ZH = '吉諾分帳所';
export const APP_NAME_EN = "Gino's Split Lab";

export function appName(zh: boolean): string {
  return zh ? APP_NAME_ZH : APP_NAME_EN;
}
