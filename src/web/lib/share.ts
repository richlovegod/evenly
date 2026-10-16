// Sending text and links to someone: invite links, claim links, sign-in links and the settle-up
// summary. Links meant for another person are built with shareLink() in config.ts first.
//
// shareOrCopy: the phone's share sheet (Web Share API) on touch devices, so it goes straight to
//   LINE, WhatsApp or Messages; on a laptop, or when sharing is not possible, it copies the
//   message and says so in a toast.
// copyText: the clipboard only, and no toast (the caller says what was copied).

import { t } from './i18n';
import { showToast } from './toast';

export interface ShareInput {
  /** A subject for the targets that use one (mail). */
  title?: string;
  /** The message. */
  text: string;
  /** A link to send with the message (put after the text on its own line). */
  url?: string;
}

/**
 * shared: the share sheet opened (this also covers the person closing it without picking an
 * app, so there is nothing to report); copied: the message is on the clipboard and a toast
 * said so; failed: neither worked (the caller shows an error).
 */
export type ShareResult = 'shared' | 'copied' | 'failed';

/**
 * The message as one piece of text: the text, then the link on its own line. Sent as text
 * rather than as a separate `url`, because some share targets on iPhone (LINE among them) keep
 * only the link when both are given.
 */
export function shareMessage({ text, url }: Pick<ShareInput, 'text' | 'url'>): string {
  const body = (text ?? '').trim();
  const link = (url ?? '').trim();
  if (!link || body.includes(link)) return body;
  return body ? body + '\n' + link : link;
}

/** Phones and tablets: the share sheet is the natural way out. On a laptop people paste instead. */
function touchFirst(): boolean {
  try {
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/**
 * Share through the system share sheet when there is one (touch devices), else copy to the
 * clipboard and show 已複製. Call it straight from a tap (no awaits before it): browsers allow
 * sharing and copying only right after a user action.
 */
export async function shareOrCopy(input: ShareInput): Promise<ShareResult> {
  const message = shareMessage(input);
  if (!message) return 'failed';

  const nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined;
  if (nav && typeof nav.share === 'function' && touchFirst()) {
    const title = input.title?.trim();
    const data: ShareData = title ? { title, text: message } : { text: message };
    let can = true;
    try {
      if (typeof nav.canShare === 'function') can = nav.canShare(data);
    } catch {
      can = false;
    }
    if (can) {
      try {
        await nav.share(data);
        return 'shared';
      } catch (e) {
        // Closing the share sheet is a choice, not an error: do not copy behind the person's back.
        if (isAbort(e)) return 'shared';
        // NotAllowedError (the tap is too long ago) and the like: copy instead.
      }
    }
  }

  const ok = await copyText(message);
  if (ok) {
    showToast({ message: t('已複製，可以貼到 LINE 或訊息裡', 'Copied. You can paste it into a message.'), kind: 'success' });
    return 'copied';
  }
  return 'failed';
}

/** Put text on the clipboard. True when it worked. No toast: the caller says what was copied. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* blocked or not allowed here: try the old way below */
  }
  return legacyCopy(text);
}

/**
 * The pre-Clipboard-API way: select the text in an off-screen textarea and run the copy
 * command. Works in older iOS versions and in http pages (no secure context).
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const box = document.createElement('textarea');
  box.value = text;
  // readonly keeps the iOS keyboard down; 16 px keeps iOS from zooming the page.
  box.setAttribute('readonly', '');
  box.setAttribute('aria-hidden', 'true');
  box.tabIndex = -1;
  box.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;margin:0;padding:0;border:0;opacity:0;font-size:16px;pointer-events:none;';
  document.body.appendChild(box);
  let ok = false;
  try {
    box.focus({ preventScroll: true });
    box.select();
    box.setSelectionRange(0, text.length); // iOS needs an explicit range
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  box.remove();
  if (active && active.isConnected) {
    try {
      active.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
  return ok;
}
