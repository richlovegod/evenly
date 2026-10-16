// Toaster (DESIGN.md 8.16): shows lib/toast's newest toast (one at a time) with its action
// (復原, 重試...). Portaled to <body> so it stays usable while a sheet makes the app inert.
// Toasts left at lib/toast's default length follow the design: 3 s, or 5 s with an action;
// an explicit duration is kept. Swipe down (or sideways) to dismiss; toasts that stay
// (duration 0) get a close button. role="status", errors role="alert".
// Test ids: toast, toast-action.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { dismissToast, useToasts, type Toast } from '../lib/toast';
import { Icon, type IconName } from './Icon';
import s from './Toaster.module.css';

const ICON: Record<Toast['kind'], IconName> = { info: 'info', success: 'check', error: 'warning' };

/** lib/toast's defaults (4 s, 6 s with an action) map to the design's 3 s and 5 s. */
function designDuration(toast: Toast): number | null {
  if (!toast.action && toast.duration === 4000) return 3000;
  if (toast.action && toast.duration === 6000) return 5000;
  return null;
}

export function Toaster() {
  const toasts = useToasts();
  const current = toasts[toasts.length - 1];
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className={s.region}>
      {current ? <ToastView key={current.id} toast={current} /> : null}
    </div>,
    document.body,
  );
}

function ToastView({ toast }: { toast: Toast }) {
  const { t } = useT();
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);

  useEffect(() => {
    const ms = designDuration(toast);
    if (ms === null) return;
    const timer = setTimeout(() => dismissToast(toast.id), ms);
    return () => clearTimeout(timer);
  }, [toast]);

  function reset() {
    const node = el.current;
    if (!node) return;
    node.style.transform = '';
    node.style.opacity = '';
  }

  return (
    <div
      ref={el}
      className={`${s.toast} ${toast.kind === 'error' ? s.error : ''}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      data-testid="toast"
      data-kind={toast.kind}
      onPointerDown={e => {
        if ((e.target as HTMLElement).closest('button')) return;
        drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const d = drag.current;
        const node = el.current;
        if (!d || d.id !== e.pointerId || !node) return;
        const dx = e.clientX - d.x;
        const dy = Math.max(0, e.clientY - d.y);
        node.style.transform = `translate(${dx}px, ${dy}px)`;
        node.style.opacity = String(Math.max(0.2, 1 - Math.max(Math.abs(dx), dy) / 160));
      }}
      onPointerUp={e => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const dx = Math.abs(e.clientX - d.x);
        const dy = e.clientY - d.y;
        if (dx > 70 || dy > 36) dismissToast(toast.id);
        else reset();
      }}
      onPointerCancel={() => {
        drag.current = null;
        reset();
      }}
    >
      <Icon name={ICON[toast.kind]} />
      <span className={s.message}>{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className={s.action}
          data-testid="toast-action"
          onClick={() => {
            const run = toast.action?.run;
            dismissToast(toast.id);
            run?.();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      {toast.duration === 0 ? (
        <button type="button" className={s.close} aria-label={t('關閉', 'Close')} onClick={() => dismissToast(toast.id)}>
          <Icon name="close" size={20} />
        </button>
      ) : null}
    </div>
  );
}
