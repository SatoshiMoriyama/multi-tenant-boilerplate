import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { getAuthStatus, signIn } from './lib/auth';
import { DashboardPage } from './pages/DashboardPage';
import { ForbiddenPage } from './pages/ForbiddenPage';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // 認証状態で分岐する。
  // - unauthenticated: そのまま Hosted UI へ（通常のログイン導線。signIn は
  //   ブラウザ遷移を起こすので以降のレンダリングは行われない）。
  // - wrong-tenant: 別テナントのトークン。signIn すると同一 User Pool の Hosted UI
  //   Cookie 素通りで同じトークンが再発行されループするため、/forbidden へ遷移
  //   させて締め出す（signIn/signOut を挟まないのでループしない）。
  beforeLoad: async () => {
    const status = await getAuthStatus();
    if (status === 'unauthenticated') {
      await signIn();
    } else if (status === 'wrong-tenant') {
      throw redirect({ to: '/forbidden' });
    }
  },
  component: DashboardPage,
});

// アクセス権が無いことを知らせる画面。認証ガードを通さない（誰でも表示できる）
// ため、wrong-tenant からの redirect がループしない。
const forbiddenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forbidden',
  component: ForbiddenPage,
});

const routeTree = rootRoute.addChildren([dashboardRoute, forbiddenRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
