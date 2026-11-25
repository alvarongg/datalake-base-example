import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { MotionConfig } from 'motion/react';
import './index.css';
import App from './App';
import { loadConfig } from './lib/auth';
import { setApiUrl } from './lib/api';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

loadConfig()
  .then((config) => {
    setApiUrl(config.apiUrl);
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        {/* reducedMotion="user": las animaciones respetan la preferencia del sistema operativo. */}
        <MotionConfig reducedMotion="user">
          <QueryClientProvider client={queryClient}>
            <App />
            <Toaster theme="dark" position="bottom-right" richColors closeButton />
          </QueryClientProvider>
        </MotionConfig>
      </StrictMode>,
    );
  })
  .catch((e) => {
    document.getElementById('root')!.textContent = `No se pudo cargar la configuración: ${e.message}`;
  });
