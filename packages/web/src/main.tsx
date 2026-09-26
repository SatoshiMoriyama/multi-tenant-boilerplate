import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { fetchAuthSession } from 'aws-amplify/auth';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { configureAmplify } from './lib/amplify';
import { router } from './router';

configureAmplify();

const queryClient = new QueryClient();

/**
 * Hosted UI からの戻り（?code=... 付き）の場合、Amplify がトークン交換を
 * 終えるまで待ってからルーターを描画する。交換前に描画すると認証ガードが
 * 未認証と判定してログインへ戻し、ループしうるため。
 */
async function bootstrap(): Promise<void> {
  const hasAuthCode = new URLSearchParams(window.location.search).has('code');
  if (hasAuthCode) {
    try {
      // トークンが用意されるまで待つ（交換完了を待機）。
      await fetchAuthSession();
    } catch {
      // 交換に失敗しても描画は続ける（ログイン画面に落ちる）。
    }
  }

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('root element not found');
  }

  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
