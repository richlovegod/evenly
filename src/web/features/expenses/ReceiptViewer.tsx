// The receipt photo viewer (docs/SPEC.md section 8.7, DESIGN.md 9.3a), for the expense editor and
// the expense's page: a full-height sheet with the entry's photos (up to three) side by side in a
// horizontal scroll-snap pager, one photo per page, each as wide as the sheet; the browser's pinch
// zoom works. With two or three photos, round ‹ and › buttons sit over the edges (hidden at the
// ends; the one pressed to get there hands focus to the other), ← and → turn the page too, and the
// title says which photo this is (收據 2/3). Closing, focus goes where the caller says (its tile for
// the photo on screen, found again then: the sheet it opened from is a new one by then). Each photo
// loads in its own child, because useReceiptImage is a hook; one that does not load says so
// (打不開收據照片) instead of spinning. The footer holds whatever removal the caller offers.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Sheet, SheetTextButton } from '../../components/Sheet';
import { Spinner } from '../../components/Spinner';
import { useT } from '../../lib/i18n';
import { receiptAspect, useReceiptImage } from '../../lib/receipts';
import s from './ReceiptViewer.module.css';

/** One page of the viewer. */
export interface ViewerPhoto {
  /** Its version (also the page's key). */
  version: string;
  width: number;
  height: number;
  /** A photo on this device (a data URL: picked in the form, or still in the outbox); else it loads from its address. */
  image?: string;
}

export interface ReceiptViewerProps {
  gid: string;
  eid: string;
  photos: readonly ViewerPhoto[];
  /** The photo it opens at (0-based). */
  start: number;
  onClose: () => void;
  /** The footer's removal of the photo on screen (none: no footer). */
  remove?: { label: string; run: (photo: ViewerPhoto, index: number) => void };
  /** Where focus goes as it closes, given the photo on screen then (0-based): the caller's tile for
   *  it, which may be a new one by then (Sheet returnFocus). */
  returnFocus?: (at: number) => HTMLElement | null;
}

export function ReceiptViewer({ gid, eid, photos, start, onClose, remove, returnFocus }: ReceiptViewerProps) {
  const { t, zh } = useT();
  const n = photos.length;
  const clamp = (i: number) => Math.max(0, Math.min(n - 1, i));
  const [at, setAt] = useState(() => clamp(start));
  const atRef = useRef(at);
  atRef.current = at;
  const pager = useRef<HTMLDivElement>(null);
  /** A page the buttons or the keys asked for, while the pager scrolls there: scroll positions on the way are not pages. */
  const target = useRef<number | null>(null);
  const prevBtn = useRef<HTMLButtonElement>(null);
  const nextBtn = useRef<HTMLButtonElement>(null);
  /** The arrow that takes focus once the page turned: the one pressed goes away at the end. */
  const refocus = useRef<'prev' | 'next' | null>(null);
  useLayoutEffect(() => {
    const which = refocus.current;
    refocus.current = null;
    (which === 'prev' ? prevBtn : which === 'next' ? nextBtn : null)?.current?.focus({ preventScroll: true });
  }, [at]);

  // Open at the photo that was tapped (before paint, so the first one never flashes).
  useLayoutEffect(() => {
    const el = pager.current;
    if (el && el.clientWidth) el.scrollLeft = at * el.clientWidth;
  }, []); // once, when it opens

  const onScroll = () => {
    const el = pager.current;
    if (!el || !el.clientWidth) return;
    const i = clamp(Math.round(el.scrollLeft / el.clientWidth));
    if (target.current !== null) {
      if (i === target.current) target.current = null;
      return;
    }
    if (i !== atRef.current) setAt(i);
  };

  const go = (i: number) => {
    const el = pager.current;
    const next = clamp(i);
    if (!el || next === atRef.current) return;
    target.current = next;
    // The arrow with focus is not shown at the end it reached: focus moves to the other one.
    const active = document.activeElement;
    if (next === 0 && active && active === prevBtn.current) refocus.current = 'next';
    else if (next === n - 1 && active && active === nextBtn.current) refocus.current = 'prev';
    setAt(next);
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ left: next * el.clientWidth, behavior: still ? 'auto' : 'smooth' });
    // A scroll that never arrives (the page was resized meanwhile) lets go of the target.
    window.setTimeout(() => {
      if (target.current === next) target.current = null;
    }, 800);
  };
  const goRef = useRef(go);
  goRef.current = go;

  // ← and → turn the page, unless a dialog is open over the viewer (removing asks first).
  useEffect(() => {
    if (n < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (document.querySelector('[data-testid="dialog-confirm"]')) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goRef.current(atRef.current - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goRef.current(atRef.current + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [n]);

  const current = photos[at];
  const title =
    n > 1 ? (
      zh ? (
        <>
          收據 <span data-testid="receipt-viewer-count">{at + 1}/{n}</span>
        </>
      ) : (
        <>
          Receipt <span data-testid="receipt-viewer-count">{at + 1} of {n}</span>
        </>
      )
    ) : (
      t('收據', 'Receipt')
    );

  return (
    <Sheet
      open
      size="full"
      flush
      onClose={onClose}
      returnFocus={returnFocus ? () => returnFocus(atRef.current) : undefined}
      title={title}
      hideClose
      headerEnd={
        <SheetTextButton onClick={onClose} data-testid="receipt-viewer-close">
          {t('關閉', 'Close')}
        </SheetTextButton>
      }
      footer={
        remove && current ? (
          <Button variant="danger-quiet" block icon="trash" onClick={() => remove.run(current, at)} data-testid="receipt-viewer-remove">
            {remove.label}
          </Button>
        ) : undefined
      }
    >
      <div className={s.viewer} data-testid="receipt-viewer" data-at={at}>
        {n > 1 ? (
          // Over the edges, in the middle of what shows (sticky inside the sheet's scrolling body).
          <div className={s.arrows}>
            {at > 0 ? (
              <button ref={prevBtn} type="button" className={s.arrow} onClick={() => go(at - 1)} aria-label={t('上一張', 'Previous photo')} data-testid="receipt-viewer-prev">
                <Icon name="chevronLeft" size={22} strokeWidth={2.6} />
              </button>
            ) : (
              <span />
            )}
            {at < n - 1 ? (
              <button ref={nextBtn} type="button" className={s.arrow} onClick={() => go(at + 1)} aria-label={t('下一張', 'Next photo')} data-testid="receipt-viewer-next">
                <Icon name="chevronRight" size={22} strokeWidth={2.6} />
              </button>
            ) : (
              <span />
            )}
          </div>
        ) : null}
        <div ref={pager} className={s.pager} onScroll={onScroll}>
          {photos.map((p, i) => (
            <ViewerPage key={p.version} gid={gid} eid={eid} photo={p} label={n > 1 ? t('第 {i} 張收據照片', 'Receipt photo {i}', { i: i + 1 }) : t('收據照片', 'Receipt photo')} hidden={i !== at} />
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/** One photo: from its data URL, or from its address (a hook per photo); one that does not load says so. */
function ViewerPage({ gid, eid, photo, label, hidden }: { gid: string; eid: string; photo: ViewerPhoto; label: string; hidden: boolean }) {
  const { t } = useT();
  const stored = useReceiptImage(gid, eid, photo.image ? null : photo);
  const src = photo.image ?? stored.src;
  return (
    <div className={s.page} aria-hidden={hidden || undefined}>
      {src ? (
        <img className={s.img} style={{ aspectRatio: receiptAspect(photo) }} src={src} alt={label} draggable={false} onError={photo.image ? undefined : stored.onError} />
      ) : stored.failed ? (
        <div className={s.cant} role="status">
          <Icon name="receipt" size={28} />
          <p className={s.cantTitle}>{t('打不開收據照片', "Can't show the receipt photo")}</p>
          <p className={s.cantBody}>{t('它可能已被換掉或移除。', 'It may have been replaced or removed.')}</p>
        </div>
      ) : (
        <div className={s.wait}>
          <Spinner size={24} label={t('載入中', 'Loading')} />
        </div>
      )}
    </div>
  );
}
