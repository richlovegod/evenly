// Members' names as the Worker takes them (routes/groups.ts name60: trimmed, 1 to 60). zod counts
// those 60 in UTF-16 units, so an emoji or a rare character such as 𠮷 takes two: a name cut at
// 60 characters could still be refused, and the only answer was 「有欄位格式不正確」. These cut by
// UTF-16 units between characters, as the iPhone app does (GroupsNames.clip, FriendsAdd.cleanName).

/** The most UTF-16 units a member's name may have (the Worker's name60). */
export const MEMBER_NAME_MAX = 60;

let graphemes: Intl.Segmenter | undefined;

/**
 * The characters people see: grapheme clusters where the browser has Intl.Segmenter, so a flag or a
 * family emoji stays whole, as on the iPhone; else code points, so at least a surrogate pair does.
 */
function characters(s: string): string[] {
  const Segmenter: typeof Intl.Segmenter | undefined = Intl.Segmenter;
  if (!Segmenter) return Array.from(s);
  graphemes ??= new Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(graphemes.segment(s), p => p.segment);
}

/** `s` cut to at most `max` UTF-16 units, between characters. */
export function clipUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = '';
  for (const ch of characters(s)) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** A typed name: runs of whitespace become one space, trimmed, cut to MEMBER_NAME_MAX, trimmed again ('' when blank). */
export function cleanName(raw: string): string {
  return clipUnits(raw.replace(/\s+/g, ' ').trim(), MEMBER_NAME_MAX).trim();
}

/** Names typed or pasted as a list ("Abbie, Kevin、Leo" or one per line), each as cleanName. */
export function splitNames(raw: string): string[] {
  return raw.split(/[,，、;；\n\r\t]+/).map(cleanName).filter(Boolean);
}
