// Tabs: navigation between sibling pages (the group's 費用 / 結算 / 統計 / 設定), drawn as a
// segmented control. Each tab is a real link; a plain tap replaces the history entry, so Back
// leaves the group instead of walking through its tabs.
// Test ids: tab.testId, or `${data-testid}-${key}` when Tabs has a data-testid
// (data-testid="group-tab" gives group-tab-expenses, ...).

import type { HTMLAttributes, MouseEvent } from 'react';
import { href as hashHref, navigate } from '../lib/router';
import s from './Tabs.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface TabItem {
  key: string;
  label: string;
  /** An app path ('/g/abc/balances') or a hash link ('#/g/abc/balances'). */
  href: string;
  badge?: number;
  testId?: string;
  'data-testid'?: string;
}

export interface TabsProps extends HTMLAttributes<HTMLElement> {
  tabs: TabItem[];
  /** Key of the current tab. */
  active: string;
  /** Accessible name of the navigation (default none). */
  label?: string;
  /** Push a history entry per tab instead of replacing (default false). */
  push?: boolean;
  /** No gutter margin: fills its container exactly. */
  bare?: boolean;
  className?: string;
}

function appPath(target: string): string | null {
  if (target.startsWith('/')) return target;
  if (target.startsWith('#/')) return target.slice(1);
  return null;
}

export function Tabs({ tabs, active, label, push, bare, className, ...rest }: TabsProps) {
  const prefix = (rest as Record<string, unknown>)['data-testid'];
  function go(e: MouseEvent<HTMLAnchorElement>, target: string) {
    const path = appPath(target);
    if (!path || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(path, { replace: !push });
  }
  return (
    <nav {...rest} aria-label={label ?? rest['aria-label']} className={cx(s.tabs, bare && s.bare, className)}>
      {tabs.map(tab => {
        const current = tab.key === active;
        const path = appPath(tab.href);
        const testId = tab.testId ?? tab['data-testid'] ?? (typeof prefix === 'string' ? `${prefix}-${tab.key}` : undefined);
        const count = tab.badge && tab.badge > 0 ? (tab.badge > 99 ? '99+' : String(tab.badge)) : null;
        return (
          <a
            key={tab.key}
            href={path ? hashHref(path) : tab.href}
            className={s.tab}
            aria-current={current ? 'page' : undefined}
            data-testid={testId}
            onClick={e => go(e, tab.href)}
          >
            <span className={s.text}>{tab.label}</span>
            {count ? <span className={s.badge} aria-hidden="true">{count}</span> : null}
            {count ? <span className="sr-only">({count})</span> : null}
          </a>
        );
      })}
    </nav>
  );
}
