// 結算圖卡's sheet, from 分享結算圖卡 on 結算: the card as it will be sent (the PNG itself, scaled to
// the sheet), and 分享, which hands the PNG file to the phone's share sheet (LINE, Instagram,
// Messages) where the browser can share files (navigator.canShare), with 下載 beside it; elsewhere
// 下載圖片 saves the PNG. The picture is made when the sheet opens (settleCardDraw.ts: the fonts
// first, then the canvas), so 分享 hands over a ready file within the tap, as browsers require, and
// it is made again when what the card says changes. The mascot is the app's own drawing
// (components/Mascot), rendered here out of sight and handed to the canvas as an SVG image.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Transfer } from '../../../shared/settle';
import type { GroupSnapshotDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { Mascot } from '../../components/Mascot';
import { Sheet } from '../../components/Sheet';
import { Spinner } from '../../components/Spinner';
import { appName } from '../../lib/brand';
import { downloadFile } from '../../lib/csv';
import { useT } from '../../lib/i18n';
import { showToast } from '../../lib/toast';
import { cardFileName, settleCardData } from './settleCard';
import { makeSettleCardPng, svgImage } from './settleCardDraw';
import s from './SettleCardSheet.module.css';

interface Made {
  key: string;
  url: string;
  file: File;
}

/** Whether this browser can hand this file to the share sheet. */
function canShareFile(file: File): boolean {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function SettleCardSheet({ snap, plan, onClose }: { snap: GroupSnapshotDTO; plan: readonly Transfer[]; onClose: () => void }) {
  const { t, zh, locale } = useT();
  const card = useMemo(() => settleCardData(snap, plan), [snap, plan]);
  const key = useMemo(() => locale + JSON.stringify(card), [card, locale]);
  const [made, setMade] = useState<Made | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mascotRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let live = true;
    setFailed(false);
    void (async () => {
      try {
        const svg = mascotRef.current?.querySelector('svg');
        const mascot = svg ? await svgImage(new XMLSerializer().serializeToString(svg)) : null;
        const lang = locale === 'en' ? 'en' : 'zh-TW';
        const blob = await makeSettleCardPng(card, { zh, locale: lang, appName: appName(zh) }, mascot);
        if (!live) return;
        const file = new File([blob], cardFileName(card.name, zh, appName(zh)), { type: 'image/png' });
        setMade(prev => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { key, url: URL.createObjectURL(blob), file };
        });
      } catch (e) {
        console.error('settle card', e);
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [key, attempt]); // the card's words and the language decide the picture

  // The last picture's address goes with the sheet.
  const madeRef = useRef<Made | null>(null);
  madeRef.current = made;
  useEffect(() => () => {
    if (madeRef.current) URL.revokeObjectURL(madeRef.current.url);
  }, []);

  const ready = made && made.key === key ? made : null;
  const shareable = ready ? canShareFile(ready.file) : false;
  const title = t(card.name + ' 結算圖卡', card.name + ' summary card');

  const download = () => {
    if (ready) downloadFile(ready.file.name, 'image/png', ready.file);
  };
  // Straight from the tap, with the file already made: no await before navigator.share.
  const share = () => {
    if (!ready) return;
    navigator.share({ files: [ready.file], title }).catch((e: unknown) => {
      // Closing the share sheet is a choice, not an error.
      if (e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError') return;
      showToast({ message: t('沒辦法分享，改成下載圖片', 'Could not share it, so it was downloaded instead'), kind: 'error' });
      download();
    });
  };

  const footer = ready ? (
    shareable ? (
      <div className={s.actions}>
        <Button variant="secondary" icon="download" onClick={download} data-testid="settle-card-download">
          {t('下載', 'Download')}
        </Button>
        <Button variant="primary" icon="share" onClick={share} className={s.primary} data-testid="settle-card-share">
          {t('分享', 'Share')}
        </Button>
      </div>
    ) : (
      <Button variant="primary" block icon="download" onClick={download} data-testid="settle-card-download">
        {t('下載圖片', 'Download the picture')}
      </Button>
    )
  ) : undefined;

  return (
    <Sheet open onClose={onClose} title={t('結算圖卡', 'Summary card')} closeLabel={t('關閉', 'Close')} footer={footer} data-testid="settle-card-sheet">
      {/* The mascot for the canvas, never shown. */}
      <span ref={mascotRef} hidden>
        <Mascot size={352} />
      </span>
      <div className={s.body}>
        {ready ? (
          <img
            className={s.preview}
            src={ready.url}
            width={1080}
            height={1350}
            alt={t(card.name + ' 的結算圖卡', 'Summary card for ' + card.name)}
            draggable={false}
            data-testid="settle-card-image"
          />
        ) : failed ? (
          <div className={s.state} role="alert">
            <p>{t('沒能做出圖卡。', 'Could not make the card.')}</p>
            <Button variant="secondary" icon="sync" onClick={() => setAttempt(n => n + 1)} data-testid="settle-card-retry">
              {t('再試一次', 'Try again')}
            </Button>
          </div>
        ) : (
          <div className={s.state} aria-busy="true">
            <Spinner size={28} label={t('正在畫圖卡', 'Drawing the card')} />
          </div>
        )}
        <p className={s.note}>{t('圖卡上只有群組裡每個人都看得到的內容。', 'The card shows only what everyone in the group can already see.')}</p>
      </div>
    </Sheet>
  );
}
