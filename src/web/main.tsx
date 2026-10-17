import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setPushSession, startPushSync } from './lib/push';
import { boot, useStore } from './lib/store';
import { registerServiceWorker } from './lib/pwa';
import './styles/tokens.css';
import './styles/global.css';

void boot();
registerServiceWorker();

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
