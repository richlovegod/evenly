// PageHeader (DESIGN.md 8.1, restyled for design/PICTUREBOOK.md): the top bar of every page,
// the award site's .top. Paper with a 7 px sky top edge and a 3 px ink bottom rule, sticky at
// the top of the screen, safe-area aware. Left: the round back button, or (top-level pages)
// the floating mascot logo; then the title and meta line. Right: round 38 px icon buttons.
// The offline, syncing and failed notes print inside it, under the bar (8.18). Also exports
// the 總覽 wordmark, the currency code pill for the meta line, and the avatar button that
// opens 我的. Height without notes: --topbar-h (66) plus the top safe area.

import { createContext, useContext, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { appName } from '../lib/brand';
import { initials } from '../lib/describe';
import { useT } from '../lib/i18n';
import { back as goBack, href as hashHref } from '../lib/router';
import { IconButton } from './IconButton';
import { Mascot } from './Mascot';
import { OfflineBanner, useBannerHost } from './OfflineBanner';
import s from './PageHeader.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  /** The meta line under the title (13 px, faded). Several children line up with 7 px gaps. */
  subtitle?: ReactNode;
  /** Fallback path for router.back(); shows a back button when set. */
  back?: string;
  /** Called instead of router.back() (e.g. to confirm leaving unsaved changes). */
  onBack?: () => void;
  /** Buttons on the right (IconButton, AccountButton, an AvatarStack link...). */
  actions?: ReactNode;
  /** A bigger title for top-level pages (群組, 朋友, 動態) and the wordmark. */
  large?: boolean;
  /** Before the title (e.g. a GroupAvatar), in place of the mascot logo. */
  leading?: ReactNode;
  /** Extra content inside the band, under the bar. */
  children?: ReactNode;
  /** Stay at the top while the page scrolls (every top bar does now; kept for callers). */
  sticky?: boolean;
  /** The compact band: a shorter bar, fixed to the top. */
  compact?: boolean;
  /** Kept for callers: the receipt band's paper slot is gone, so this changes nothing. */
  noSlot?: boolean;
  /** Leave out the offline / sync notes (another band on the screen shows them). */
  noNotes?: boolean;
  className?: string;
}

export function PageHeader({ title, subtitle, back, onBack, actions, large, leading, children, sticky, compact, noSlot, noNotes, className, ...rest }: PageHeaderProps) {
  const { t } = useT();
  const hasBack = back !== undefined || onBack !== undefined;
  // On desktop the sidebar carries the mascot and the wordmark, so they print once.
  const besideBrand = useContext(SidebarBrand);
  return (
    <header {...rest} className={cx(s.band, large && s.large, sticky && s.sticky, compact && s.compact, noSlot && s.noSlot, className)}>
      <div className={s.bar}>
        {hasBack ? (
          <IconButton
            icon="back"
            label={t('返回', 'Back')}
            data-testid="header-back"
            className={s.back}
            onClick={() => (onBack ? onBack() : goBack(back ?? '/'))}
          />
        ) : null}
        {leading ? <div className={s.leading}>{leading}</div> : !hasBack && !besideBrand ? <Mascot size={38} float className={s.logo} /> : null}
        <div className={cx(s.head, !hasBack && !leading && besideBrand && s.pad)}>
          <h1 className={s.title}>{title}</h1>
          {subtitle !== undefined && subtitle !== null && subtitle !== '' ? <div className={s.subtitle}>{subtitle}</div> : null}
        </div>
        {actions ? <div className={s.actions}>{actions}</div> : null}
      </div>
      {noNotes || compact ? null : <BandNotes />}
      {children}
    </header>
  );
}

/** The status notes inside this band; while mounted, AppShell leaves out its own strip. */
function BandNotes() {
  useBannerHost();
  return <OfflineBanner variant="notes" />;
}

/** True inside AppShell's content column while the desktop sidebar prints the wordmark over its
 *  end of the band (DESIGN.md 7.2). AppShell provides it; everything else sees false. */
export const SidebarBrand = createContext(false);

/** The app's name as printed on the top bar, 吉諾分帳所 or Gino's Split Lab (lib/brand.ts; use
 *  as the 總覽 title). On desktop the sidebar
 *  already prints it, so a page band inside the shell's column gets the page title 總覽 instead,
 *  like 群組, 朋友 and 動態, and the brand shows once. */
export function Wordmark() {
  const { zh, t } = useT();
  const inColumnBesideBrand = useContext(SidebarBrand);
  if (inColumnBesideBrand) return <>{t('總覽', 'Home')}</>;
  return (
    <span className={s.wordmark}>
      <b>{appName(zh)}</b>
    </span>
  );
}

/** The currency code pill for the band's meta line: <PageHeaderCode>JPY</PageHeaderCode>. */
export function PageHeaderCode({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...rest} className={cx(s.code, className)}>{children}</span>;
}

export interface AccountButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'color'> {
  name: string;
  /** Accepted for symmetry with Avatar; the bar always prints you in yolk, like 你 everywhere. */
  color?: string;
  /** Where it goes (default the account page). */
  to?: string;
  className?: string;
}

/** The round avatar button on the bar that opens 我的 / Account (pass data-testid="home-account"). */
export function AccountButton({ name, color: _color, to = '/account', className, ...rest }: AccountButtonProps) {
  const { t } = useT();
  return (
    <a
      {...rest}
      href={to.startsWith('/') ? hashHref(to) : to}
      className={cx(s.account, className)}
      aria-label={rest['aria-label'] ?? t('我的帳號：{name}', 'My account: {name}', { name })}
    >
      <span className={s.me} aria-hidden="true">{initials(name)}</span>
    </a>
  );
}
