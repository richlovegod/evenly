// 中文 / English on the welcome page's sky picture (top right, like the award site's login): two
// small pills in one outline, the chosen language in yolk.

import type { Locale } from '../../../shared/types';
import { useT } from '../../lib/i18n';
import { cx } from './Receipt';
import s from './LangSwitch.module.css';

/** Each language is named in itself, in both UIs, so people can always find their own. */
const OPTIONS: { value: Locale; label: string; lang: string }[] = [
  { value: 'zh-TW', label: '中文', lang: 'zh-Hant-TW' },
  { value: 'en', label: 'English', lang: 'en' },
];

export function LangSwitch({
  value,
  onChange,
  ids,
  className,
}: {
  value: Locale;
  onChange: (l: Locale) => void;
  /** Test ids of the two options. */
  ids: { zh: string; en: string };
  className?: string;
}) {
  const { t } = useT();
  return (
    <div role="group" aria-label={t('語言', 'Language')} className={cx(s.seg, className)}>
      {OPTIONS.map(o => (
        <button
          key={o.value}
          type="button"
          lang={o.lang}
          className={s.opt}
          aria-pressed={value === o.value}
          data-testid={o.value === 'zh-TW' ? ids.zh : ids.en}
          onClick={() => {
            if (value !== o.value) onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
