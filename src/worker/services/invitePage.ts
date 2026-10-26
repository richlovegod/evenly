// The page a friend invite link opens, GET /i/<code> (index.ts): the built app's index.html with
// its preview tags (Open Graph, the Twitter card, the description and the title) saying who sent
// the invite, so LINE, Messenger, iMessage and the like show 「Gino 邀請你一起用吉諾分帳所分帳」 over
// the mascot. Crawlers read only these tags. A browser runs index.html's first script, which moves
// the address to /#/i/<code> before anything else loads, and the app starts there. Nothing personal
// goes in but the name: never an email, and the image is the mascot, not the person's photo.

import { zhJoin } from './pushText';

/** The tags this module writes. index.html carries the app's own (the generic preview) for every other page. */
export interface PageTags {
  title: string;
  description: string;
  /** The link the preview stands for (the invite's share URL). */
  url: string;
  /** An absolute URL of the 1200 x 630 preview image. */
  image: string;
  /** og:locale: zh_TW or en_US. */
  locale: 'zh_TW' | 'en_US';
}

/** The preview image under the app's URL (public/og-image.png, made by scripts/make-icons.cjs). */
export const OG_IMAGE_PATH = 'og-image.png';

/** The invite's tags, in the inviter's language (the people they send it to most likely read it). */
export function inviteTags(o: { appUrl: string; url: string; name: string; locale: string }): PageTags {
  // A name is one line of plain text here, whatever was typed into it.
  const name = o.name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim() || '?';
  const image = new URL(OG_IMAGE_PATH, o.appUrl).toString();
  if (o.locale === 'en') {
    return {
      title: `${name} invited you to split costs on Gino's Split Lab`,
      description: "Open the link to join and you're friends there: log shared costs and see who owes whom, no app to install.",
      url: o.url,
      image,
      locale: 'en_US',
    };
  }
  return {
    title: zhJoin(name, '邀請你一起用吉諾分帳所分帳'),
    description: '打開連結加入，你們就是朋友了：一起記帳，算好誰該付誰，不用下載 App。',
    url: o.url,
    image,
    locale: 'zh_TW',
  };
}

/** Text for an HTML attribute value or element content. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const reSafe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Set the content of `<meta attr="key" content="...">`, or add the tag before </head> when the page has none. */
function setMeta(html: string, attr: 'name' | 'property', key: string, value: string): string {
  const tag = `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;
  const re = new RegExp(`<meta\\s+${attr}="${reSafe(key)}"\\s+content="[^"]*"\\s*/?>`, 'i');
  if (re.test(html)) return html.replace(re, () => tag);
  return html.replace(/<\/head>/i, () => `  ${tag}\n  </head>`);
}

/**
 * index.html with these tags in place of its own: the title, the description, og:title,
 * og:description, og:url, og:image, og:locale and its alternate, and the Twitter card's title,
 * description and image (og:image:alt keeps index.html's words about the mascot). Pure, so tests
 * run it on the real index.html.
 */
export function withTags(html: string, t: PageTags): string {
  let out = html.replace(/<title>[^<]*<\/title>/i, () => `<title>${escapeHtml(t.title)}</title>`);
  out = setMeta(out, 'name', 'description', t.description);
  out = setMeta(out, 'property', 'og:title', t.title);
  out = setMeta(out, 'property', 'og:description', t.description);
  out = setMeta(out, 'property', 'og:url', t.url);
  out = setMeta(out, 'property', 'og:image', t.image);
  out = setMeta(out, 'property', 'og:locale', t.locale);
  out = setMeta(out, 'property', 'og:locale:alternate', t.locale === 'en_US' ? 'zh_TW' : 'en_US');
  out = setMeta(out, 'name', 'twitter:title', t.title);
  out = setMeta(out, 'name', 'twitter:description', t.description);
  out = setMeta(out, 'name', 'twitter:image', t.image);
  return out;
}
