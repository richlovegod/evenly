// Friend invite links (docs/SPEC.md sections 4 and 6, Friend invites). The ready-made messages an
// inviter picks from live here and nowhere else: the Worker sends them to both apps (GET
// /api/me/invite) in the language asked for, and the apps put the link after them on its own line.
// Also the link's shape: the Worker builds it (the apps never do) and the web app reads the code
// out of a pasted one, of either form.

import type { InviteTemplateDTO, InviteTemplateKey, Locale } from './types';

/** A personal invite code: random base62. The Worker makes 16 characters and accepts 10 to 64. */
export const INVITE_CODE_RE = /^[A-Za-z0-9]{10,64}$/;

interface Template {
  key: InviteTemplateKey;
  zh: { label: string; text: string };
  en: { label: string; text: string };
}

/** The three messages, in the order the chips show them (Gino's wording, 2026-10-25). */
export const INVITE_TEMPLATES: readonly Template[] = [
  {
    key: 'everyday',
    zh: { label: '日常', text: '我最近都用吉諾分帳所記分帳，誰付了多少、誰欠誰一目了然。點連結加入，我們就是朋友了，不用下載 App：' },
    en: {
      label: 'Everyday',
      text: "I've been using Gino's Split Lab to keep track of shared costs: who paid what and who owes whom, all in one place. Open the link to join and we'll be friends there, no app to install:",
    },
  },
  {
    key: 'trip',
    zh: { label: '旅行', text: '下次出去玩用吉諾分帳所分帳吧！各自付的錢記進去，最後幫我們算好誰該給誰。點連結加入：' },
    en: {
      label: 'Trip',
      text: "Let's use Gino's Split Lab on our next trip! Log what each of us pays, and it works out who owes whom at the end. Open the link to join:",
    },
  },
  {
    key: 'roommates',
    zh: { label: '室友', text: '房租、水電、買菜都記在吉諾分帳所，每個月不用再對帳。點連結跟我一起記：' },
    en: {
      label: 'Roommates',
      text: "Rent, utilities, groceries: let's log them all in Gino's Split Lab and skip the monthly reckoning. Open the link to join me:",
    },
  },
];

/** The messages in one language (zh-TW for anything but en). */
export function inviteTemplates(locale: Locale): InviteTemplateDTO[] {
  const lang = locale === 'en' ? 'en' : 'zh';
  return INVITE_TEMPLATES.map(t => ({ key: t.key, label: t[lang].label, text: t[lang].text }));
}

/**
 * The link to share: the page the Worker serves for the invite (its preview tags, then the app at
 * #/i/<code>) under the app's own URL. `?openExternalBrowser=1` makes LINE open it in the phone's
 * real browser, as the group links do: its in-app browser loses the sign-in, and Google refuses it.
 */
export function inviteUrl(appUrl: string, code: string): string {
  const base = appUrl.endsWith('/') ? appUrl : appUrl + '/';
  return base + 'i/' + encodeURIComponent(code) + '?openExternalBrowser=1';
}

/**
 * The code in pasted text that holds a friend invite link of either form, `https://<site>/i/<code>`
 * or `https://<site>/#/i/<code>` (with or without the query, and with the message around it), else
 * null. A bare code is not read as one: the paste box takes those as group invite codes.
 */
export function inviteCodeInLink(text: string): string | null {
  const m = /(?:^|[/#])i\/([A-Za-z0-9]{10,64})(?=$|[/?#&\s])/.exec(text.trim());
  return m ? m[1] : null;
}
