// Route table and sign-in gate. Each page is its own module under features/.

import { useEffect } from 'react';
import { AppShell } from './components/AppShell';
import { Toaster } from './components/Toaster';
import { DialogHost } from './components/Dialog';
import { useT } from './lib/i18n';
import { navigate, useRoute, type Route } from './lib/router';
import { useStore } from './lib/store';
import { WelcomePage } from './features/auth/WelcomePage';
import { LoginPage } from './features/auth/LoginPage';
import { LinkPage } from './features/auth/LinkPage';
import { ResetPage } from './features/auth/ResetPage';
import { HomePage } from './features/home/HomePage';
import { GroupsPage } from './features/groups/GroupsPage';
import { NewGroupPage } from './features/groups/NewGroupPage';
import { GroupPage } from './features/groups/GroupPage';
import { ExpenseEditorPage } from './features/expenses/ExpenseEditorPage';
import { ExpenseDetailPage } from './features/expenses/ExpenseDetailPage';
import { SettleUpPage } from './features/settle/SettleUpPage';
import { FriendsPage } from './features/friends/FriendsPage';
import { FriendPage } from './features/friends/FriendPage';
import { AddFriendPage } from './features/friends/AddFriendPage';
import { ActivityPage } from './features/activity/ActivityPage';
import { AccountPage } from './features/account/AccountPage';
import { AdminPage } from './features/account/AdminPage';
import { JoinPage } from './features/join/JoinPage';
import { ClaimPage } from './features/join/ClaimPage';

/** Routes that work without signing in. */
const PUBLIC = new Set(['welcome', 'login', 'link', 'reset', 'join', 'claim']);
/** Routes that make no sense once signed in. */
const GUEST_ONLY = new Set(['welcome', 'login']);
/** Full-screen routes without the tab bar or sidebar. */
const BARE = new Set(['welcome', 'login', 'link', 'reset', 'join', 'claim', 'addExpense', 'editExpense', 'settle', 'newGroup', 'addFriend']);

const RETURN_KEY = 'evenly.returnTo';

/** Remember where to go after signing in (e.g. a join link opened while signed out). */
export function rememberReturn(path: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, path);
  } catch {
    /* ignore */
  }
}

/** Where to go after signing in: the remembered path or home. */
export function takeReturn(): string {
  try {
    const p = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (p && p.startsWith('/')) return p;
  } catch {
    /* ignore */
  }
  return '/';
}

function Page({ route }: { route: Route }) {
  const { t } = useT();
  const p = route.params;
  switch (route.name) {
    case 'welcome': return <WelcomePage />;
    case 'login': return <LoginPage />;
    case 'link': return <LinkPage code={p.code} />;
    case 'reset': return <ResetPage token={p.token} />;
    case 'home': return <HomePage />;
    case 'groups': return <GroupsPage />;
    case 'newGroup': return <NewGroupPage />;
    case 'group': return <GroupPage gid={p.gid} tab="expenses" />;
    case 'groupBalances': return <GroupPage gid={p.gid} tab="balances" />;
    case 'groupStats': return <GroupPage gid={p.gid} tab="stats" />;
    case 'groupSettings': return <GroupPage gid={p.gid} tab="settings" />;
    case 'addExpense': return <ExpenseEditorPage gid={p.gid} />;
    case 'editExpense': return <ExpenseEditorPage gid={p.gid} eid={p.eid} />;
    case 'expense': return <ExpenseDetailPage gid={p.gid} eid={p.eid} />;
    case 'settle': return <SettleUpPage gid={p.gid} />;
    case 'friends': return <FriendsPage />;
    case 'friend': return <FriendPage friendKey={p.key} />;
    case 'addFriend': return <AddFriendPage />;
    case 'activity': return <ActivityPage />;
    case 'account': return <AccountPage />;
    case 'admin': return <AdminPage />;
    case 'join': return <JoinPage code={p.code} />;
    case 'claim': return <ClaimPage token={p.token} />;
    default:
      return (
        <div style={{ padding: 24 }}>
          <p>{t('找不到這個頁面。', 'This page does not exist.')}</p>
          <p><a href="#/">{t('回到總覽', 'Back to Home')}</a></p>
        </div>
      );
  }
}

export function App() {
  const route = useRoute();
  const token = useStore(s => s.token);
  const booted = useStore(s => s.booted);

  const blocked = !token && !PUBLIC.has(route.name);
  const bounce = !!token && GUEST_ONLY.has(route.name);

  useEffect(() => {
    if (!booted) return;
    if (blocked) {
      // After an explicit sign-out there is nothing to come back to.
      let signedOut = false;
      try {
        signedOut = sessionStorage.getItem('evenly.signedOut') === '1';
        sessionStorage.removeItem('evenly.signedOut');
      } catch {
        /* ignore */
      }
      if (route.name !== 'home' && !signedOut) rememberReturn(route.path + (route.query.toString() ? '?' + route.query.toString() : ''));
      navigate('/welcome', { replace: true });
    } else if (bounce) {
      navigate('/', { replace: true });
    }
  }, [booted, blocked, bounce, route]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.path]);

  if (!booted || blocked || bounce) return <><Toaster /><DialogHost /></>;
  return (
    <>
      {BARE.has(route.name) ? (
        <Page route={route} />
      ) : (
        <AppShell route={route}>
          <Page route={route} />
        </AppShell>
      )}
      <Toaster />
      <DialogHost />
    </>
  );
}
