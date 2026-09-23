import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

/**
 * CORS ミドルウェア。許可オリジンは環境変数 ALLOWED_ORIGINS（カンマ区切り）で
 * 明示リスト制御する。リクエストの Origin が許可リストにあるときだけ、その
 * オリジンを Access-Control-Allow-Origin に反映する（動的出し分け）。
 *
 * トークンは Authorization: Bearer で送るため Cookie は使わない。したがって
 * credentials は付けない（true にすると許可オリジンにワイルドカードを使えず、
 * 本構成では不要な制約になる）。
 *
 * ここで扱うのは実リクエスト(GET等)のレスポンスへの CORS ヘッダー付与のみ。
 * プリフライト(OPTIONS)は Lambda に届かず、API Gateway の MOCK 統合が直接返す
 * （packages/cdk/lib/constructs/api.ts の addCorsPreflight）。本体 Lambda は
 * テナント分離モードで X-Amz-Tenant-Id 必須のため OPTIONS を流せないため。
 */
export const corsMiddleware = (): MiddlewareHandler => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  return cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });
};
