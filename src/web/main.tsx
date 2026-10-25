import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setPushSession, startPushSync } from './lib/push';
import { boot, useStore } from './lib/store';
import { isIosDevice, registerServiceWorker } from './lib/pwa';
import { installFocusRelease, installRootScrollGuard } from './lib/viewport';
import './styles/tokens.css';
import './styles/global.css';

void boot();
registerServiceWorker();
// When the web view keeps a keyboard inset after the keyboard left (iOS 26 and 27), the page can
// come to rest scrolled past its end over a blank band: once it is still, scroll it back
// (lib/viewport.ts, DESIGN.md 9.5), for the whole visit. iOS only, where that bug lives: elsewhere
// a browser's own keyboard (Android Chrome's find in page) can hold a page past its end with nobody
// typing in it, and the guard would scroll the match out of sight.
if (isIosDevice()) installRootScrollGuard();
// On a touch screen, a field the page lost focus with (Chrome for iOS's own keyboard button, its
// address bar, an app switch) is blurred on every page, as the add sheet's typing watch does
// there: WebKit would focus it again with no keyboard at the next tap, and the guard above and the
// sheets would take that for typing over a kept keyboard inset (lib/viewport.ts
// installFocusRelease, DESIGN.md 9.5). On every platform: it only acts once the page itself has
// lost focus, the add sheet already does so everywhere, and with a mouse (pointer: fine, read at
// each check, as the add sheet reads its own) it does nothing.
installFocusRelease(() => window.matchMedia('(pointer: fine)').matches);

/**
 * At start and after every sign-in (the session key changes with each one), link this device's
 * push subscription to the session, and keep it in step while signed in (lib/push.ts
 * startPushSync). Push only follows the account that turned it on here, so it needs the account
 * id, which arrives with /api/me after a Bearer sign-in. When the account leaves the device (the
 * session key goes null, or another account signs in), setPushSession drops the browser's
 * subscription. Renders nothing.
 */
function PushSync() {
  const session = useStore(st => st.token);
  const account = useStore(st => st.me?.user.id ?? null);
  useEffect(() => {
    setPushSession(session, account);
    return session && account ? startPushSync() : undefined;
  }, [session, account]);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <PushSync />
  </StrictMode>,
);
