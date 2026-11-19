import { createRoot } from 'react-dom/client';
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import 'pearkit/global.css';
import { MOCK, setApi } from './api';
import { setEventSourceFactory } from './events';
import { App } from './App';
import { setClipboardWriter } from 'pearkit';

/**
 * iOS scrolls the page to a focused field and shrinks the visual viewport under the keyboard. Size the root to
 * the visual viewport and keep the page at scroll 0, so the top bar stays where it is while typing.
 */
function followVisualViewport() {
  const vv = window.visualViewport;
  const root = document.getElementById('root');
  if (!vv || !root) return;
  const apply = () => {
    root.style.height = `${Math.round(vv.height)}px`;
    if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('scroll', () => window.scrollTo(0, 0), { passive: true });
  apply();
}

// Inside the phone app the page has no browser clipboard (plain http in a WebView): the app bridges it.
declare global { interface Window { rkcMobile?: { copy: (t: string) => boolean; share?: (t: string) => boolean } } }
function useAppClipboard() {
  if (window.rkcMobile?.copy) setClipboardWriter((text) => window.rkcMobile!.copy(text));
}

async function boot() {
  followVisualViewport();
  useAppClipboard();
  if (MOCK) {
    const { mockApi, mockEventSource } = await import('./mock');
    setApi(mockApi);
    setEventSourceFactory(mockEventSource);
    document.title = 'rKeyChat (mock)';
  }
  createRoot(document.getElementById('root')!).render(<App />);
}

void boot();
