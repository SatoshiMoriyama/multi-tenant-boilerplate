import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { isAuthenticated, signIn } from './lib/auth';
import { DashboardPage } from './pages/DashboardPage';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // 未認証なら中間画面を挟まず、そのまま Cognito Hosted UI へリダイレクトする。
  // signInWithRedirect はブラウザ遷移を起こすので、以降のレンダリングは行われない。
  beforeLoad: async () => {
    if (!(await isAuthenticated())) {
      await signIn();
    }
  },
  component: DashboardPage,
});

const routeTree = rootRoute.addChildren([dashboardRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
