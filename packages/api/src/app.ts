import { Hono } from 'hono';
import { type TenantEnv, tenantContext } from './middleware/tenant.js';

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
  // 検証用にリクエストヘッダも返す。Authorization はトークンが平文で
  // 入るためマスクする（値の有無だけ分かる形にする）。
  const headers: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) {
    headers[key] =
      key.toLowerCase() === 'authorization' ? '***masked***' : value;
  }
  return c.json({ tenantId, headers });
});

app.notFound((c) => c.json({ message: 'Not Found' }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ message: 'Internal Server Error' }, 500);
});
