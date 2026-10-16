import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { boot } from './lib/store';
import { registerServiceWorker } from './lib/pwa';
import './styles/tokens.css';
import './styles/global.css';

void boot();
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
