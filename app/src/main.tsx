import { createRoot } from 'react-dom/client';
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import 'pearkit/global.css';
import { MOCK, setApi } from './api';
import { setEventSourceFactory } from './events';
import { App } from './App';

async function boot() {
  if (MOCK) {
    const { mockApi, mockEventSource } = await import('./mock');
    setApi(mockApi);
    setEventSourceFactory(mockEventSource);
    document.title = 'rKeyChat (mock)';
  }
  createRoot(document.getElementById('root')!).render(<App />);
}

void boot();
