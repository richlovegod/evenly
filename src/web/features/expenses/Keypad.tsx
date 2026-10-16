// The register: the calculator keys under the receipt, with 儲存 as the tall key on the right.
// Keys only send PadKey values; editorLogic.pressKey decides what they do to the amount.

import { useRef } from 'react';
import { useT } from '../../lib/i18n';
import type { PadKey } from './editorLogic';
import { Icon } from '../../components/Icon';
import styles from './Keypad.module.css';

export interface KeypadProps {
  onKey: (key: PadKey) => void;
  /** Currency decimals: with decimals the bottom-left key is the point, else 000. */
  decimals: number;
  /** Called on every tap of 儲存; while `saveDisabled` the page points at what is missing instead of saving. */
  onSave: () => void;
  /** Shown as aria-disabled (still tappable, so the tap can explain what is missing). */
  saveDisabled: boolean;
  /** The line under 儲存: the group it saves to. */
  saveNote: string;
  /** Why saving is not possible yet (read out with the key while it is disabled). */
  saveReason?: string;
  saveLabel?: string;
}

const LONG_PRESS_MS = 450;

export function Keypad({ onKey, decimals, onSave, saveDisabled, saveNote, saveReason, saveLabel }: KeypadProps) {
  const { t } = useT();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleared = useRef(false);

  const digit = (d: PadKey) => (
    <button key={d} type="button" className={styles.key} onClick={() => onKey(d)} data-testid={`key-${d}`}>
      {d}
    </button>
  );

  const startHold = () => {
    cleared.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      cleared.current = true;
      onKey('clear');
    }, LONG_PRESS_MS);
  };
  const endHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <div className={styles.keypad} role="group" aria-label={t('輸入金額', 'Enter the amount')}>
      {digit('1')}
      {digit('2')}
      {digit('3')}
      <button
        type="button"
        className={`${styles.key} ${styles.op}`}
        aria-label={t('刪除（按住全部清除）', 'Delete (hold to clear)')}
        data-testid="key-del"
        onPointerDown={startHold}
        onPointerUp={endHold}
        onPointerLeave={endHold}
        onPointerCancel={endHold}
        onContextMenu={e => e.preventDefault()}
        onClick={() => {
          if (cleared.current) {
            cleared.current = false;
            return;
          }
          onKey('del');
        }}
      >
        <Icon name="backspace" size={26} strokeWidth={1.7} />
      </button>
      {digit('4')}
      {digit('5')}
      {digit('6')}
      <button type="button" className={`${styles.key} ${styles.op}`} aria-label={t('加', 'Plus')} data-testid="key-plus" onClick={() => onKey('+')}>
        <Icon name="plus" size={22} strokeWidth={2.4} />
      </button>
      {digit('7')}
      {digit('8')}
      {digit('9')}
      <button
        type="button"
        className={styles.save}
        onClick={onSave}
        aria-disabled={saveDisabled || undefined}
        data-testid="editor-save"
      >
        <b>{saveLabel ?? t('儲存', 'Save')}</b>
        {saveNote ? <small>{saveNote}</small> : null}
        {saveDisabled && saveReason ? <span className="sr-only">{saveReason}</span> : null}
      </button>
      {decimals > 0 ? (
        <button type="button" className={`${styles.key} ${styles.point}`} aria-label={t('小數點', 'Decimal point')} data-testid="key-point" onClick={() => onKey('.')}>
          .
        </button>
      ) : (
        <button type="button" className={`${styles.key} ${styles.k000}`} aria-label={t('三個零', 'Three zeros')} data-testid="key-000" onClick={() => onKey('000')}>
          000
        </button>
      )}
      {digit('0')}
      <button type="button" className={`${styles.key} ${styles.op}`} aria-label={t('減', 'Minus')} data-testid="key-minus" onClick={() => onKey('-')}>
        <Icon name="minus" size={22} strokeWidth={2.4} />
      </button>
    </div>
  );
}
