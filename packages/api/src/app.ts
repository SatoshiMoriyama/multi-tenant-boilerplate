import { Hono } from 'hono';
import { tenantContext, type TenantEnv } from './middleware/tenant.js';

/**
 * Lambda-lith の Hono アプリ。全ルートをこのアプリに集約する。
 * テナントは Lambda Authorizer が返した context.tenantId（JWT由来）を正とする。
 */
export const app = new Hono<TenantEnv>();

app.use('*', tenantContext());

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

app.get('/me', (c) => {
  const tenantId = c.get('tenantId');
  return c.json({ tenantId });
});

// サンプル: テナントスコープのリソース
app.get('/items', (c) => {
  const tenantId = c.get('tenantId');
  return c.json({ tenantId, items: [] });
});

app.notFound((c) => c.json({ message: 'Not Found' }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ message: 'Internal Server Error' }, 500);
});
