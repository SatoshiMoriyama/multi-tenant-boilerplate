import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors.js';
import { type TenantEnv, tenantContext } from './middleware/tenant.js';

/**
 * Lambda-lith の Hono アプリ。全ルートをこのアプリに集約する。
 * テナントは Lambda Authorizer が返した context.tenantId（JWT由来）を正とする。
 */
export const app = new Hono<TenantEnv>();

// CORS はテナントコンテキスト検証より前。プリフライト(OPTIONS)は認証情報を
// 運ばないため、tenantContext の 403 に巻き込まれずに応答させる。
app.use('*', corsMiddleware());
app.use('*', tenantContext());

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// /me が返すリクエストヘッダのうち、値を隠すもの（小文字で比較）。
// - authorization: JWT が平文で入る
// - x-origin-verify: CloudFront が付与するオリジン検証シークレット。
//   露出すると直アクセスでオリジン保護を回避されるため必ずマスクする。
const MASKED_HEADERS = new Set(['authorization', 'x-origin-verify']);

app.get('/me', (c) => {
  const tenantId = c.get('tenantId');
  // 検証用にリクエストヘッダも返す。シークレット系は値をマスクし、
  // 有無だけ分かる形にする。
  const headers: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) {
    headers[key] = MASKED_HEADERS.has(key.toLowerCase())
      ? '***masked***'
      : value;
  }
  return c.json({ tenantId, headers });
});

app.notFound((c) => c.json({ message: 'Not Found' }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ message: 'Internal Server Error' }, 500);
});
