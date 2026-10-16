// QRCode: a QR code drawn as one SVG path (qrcode-generator, automatic size, error correction
// M), with the 4-module quiet zone scanners need. Ink modules on paper (scanners read
// light-on-dark codes badly). The text is encoded as UTF-8.

import qrcode from 'qrcode-generator';
import { useMemo, type SVGProps } from 'react';
import { useT } from '../lib/i18n';
import s from './QRCode.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Modules of light margin around the code (the QR spec asks for 4). */
const QUIET = 4;

export interface QRShape {
  /** Width and height of the drawing in modules, quiet zone included. */
  size: number;
  /** SVG path of the dark modules (runs of modules merged per row). */
  path: string;
}

/** UTF-8 bytes as a "binary string", which qrcode-generator's byte mode takes one char per byte. */
function utf8Binary(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** The QR code for `text` as an SVG path, or null when the text is empty or too long for a QR code. */
export function qrShape(text: string): QRShape | null {
  if (!text) return null;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(utf8Binary(text), 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const parts: string[] = [];
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!qr.isDark(r, c)) {
          c++;
          continue;
        }
        const start = c;
        while (c < n && qr.isDark(r, c)) c++;
        parts.push(`M${start + QUIET} ${r + QUIET}h${c - start}v1h-${c - start}z`);
      }
    }
    return { size: n + QUIET * 2, path: parts.join('') };
  } catch {
    return null; // more data than a QR code holds
  }
}

export interface QRCodeProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'children'> {
  /** What the code holds, usually a link. */
  text: string;
  /** Width and height in px (default 168). */
  size?: number;
  /** Accessible name (default: QR Code plus the text). */
  label?: string;
  className?: string;
}

export function QRCode({ text, size = 168, label, className, style, ...rest }: QRCodeProps) {
  const { t } = useT();
  const shape = useMemo(() => qrShape(text), [text]);
  if (!shape) {
    // Only for empty text or text longer than a QR code holds (about 2,300 bytes).
    return (
      <span className={cx(s.qr, s.empty, className)} style={{ width: size, height: size, ...style }} role="note">
        {t('無法產生 QR Code', 'No QR code for this')}
      </span>
    );
  }
  const n = shape.size;
  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      role="img"
      aria-label={label ?? t('QR Code：{text}', 'QR code: {text}', { text })}
      focusable="false"
      shapeRendering="crispEdges"
      className={cx(s.qr, className)}
      style={style}
      {...rest}
    >
      <rect className={s.ground} width={n} height={n} rx={1.5} />
      <path className={s.ink} d={shape.path} />
    </svg>
  );
}
