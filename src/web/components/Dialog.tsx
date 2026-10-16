// Dialogs as promises: `if (await confirmDialog({ title, danger: true })) ...` and
// `const name = await promptDialog({ title, label })` (null when cancelled).
// DialogHost (mounted once by App) shows them one at a time, in a portal above sheets.
// Test ids: dialog-confirm, dialog-cancel, prompt-input.

import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { TextField } from './TextField';
import { useOverlay, useViewportBox, viewportStyle } from './Sheet';
import s from './Dialog.module.css';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** A destructive action: the confirm button is solid red and focus starts on cancel. */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  /** Label of the text field. */
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Keyboard and autofill hints for the field. */
  type?: 'text' | 'email' | 'password';
  danger?: boolean;
}

type Request =
  | { id: number; kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { id: number; kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void };

let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Ask a yes/no question. Resolves true for confirm, false for cancel, Escape or a scrim tap. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    queue = [...queue, { id: nextId++, kind: 'confirm', opts, resolve }];
    emit();
  });
}

/** Ask for one line of text. Resolves the text (untrimmed) or null when cancelled. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise(resolve => {
    queue = [...queue, { id: nextId++, kind: 'prompt', opts, resolve }];
    emit();
  });
}

function settle(req: Request, ok: boolean, text: string): void {
  if (!queue.some(r => r.id === req.id)) return;
  queue = queue.filter(r => r.id !== req.id);
  emit();
  if (req.kind === 'confirm') req.resolve(ok);
  else req.resolve(ok ? text : null);
}

export function DialogHost() {
  const list = useSyncExternalStore(subscribe, () => queue, () => queue);
  const current = list[0];
  if (!current || typeof document === 'undefined') return null;
  return <DialogView key={current.id} req={current} />;
}

function DialogView({ req }: { req: Request }) {
  const { t } = useT();
  const ids = useId();
  const card = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(req.kind === 'prompt' ? req.opts.initial ?? '' : '');
  const box = useViewportBox(true);
  const danger = !!req.opts.danger;
  const done = (ok: boolean) => settle(req, ok, text);

  useOverlay(true, card, {
    onEscape: () => done(false),
    initialFocus: () => {
      const el = card.current;
      if (!el) return null;
      if (req.kind === 'prompt') return el.querySelector<HTMLElement>('input');
      return el.querySelector<HTMLElement>(danger ? '[data-testid="dialog-cancel"]' : '[data-testid="dialog-confirm"]');
    },
  });

  const titleId = ids + 't';
  const msgId = ids + 'm';
  return createPortal(
    <div className={s.root} style={viewportStyle(box)}>
      <div className={s.scrim} onClick={() => done(false)} />
      <div
        ref={card}
        className={s.card}
        role={req.kind === 'confirm' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={req.opts.message ? msgId : undefined}
        tabIndex={-1}
        data-testid="dialog"
      >
        <h2 id={titleId} className={s.title}>{req.opts.title}</h2>
        {req.opts.message ? <p id={msgId} className={s.message}>{req.opts.message}</p> : null}
        {req.kind === 'prompt' ? (
          <div className={s.field}>
            <TextField
              bare
              label={req.opts.label}
              value={text}
              onChange={setText}
              placeholder={req.opts.placeholder}
              type={req.opts.type ?? 'text'}
              autoComplete={req.opts.type === 'password' ? 'current-password' : 'off'}
              onEnter={() => done(true)}
              enterKeyHint="done"
              data-testid="prompt-input"
            />
          </div>
        ) : null}
        <div className={s.actions}>
          <Button variant="secondary" block data-testid="dialog-cancel" onClick={() => done(false)}>
            {req.opts.cancelLabel ?? t('取消', 'Cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} size="md" block data-testid="dialog-confirm" onClick={() => done(true)}>
            {req.opts.confirmLabel ?? t('確定', 'OK')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
