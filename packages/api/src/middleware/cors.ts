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
 * プリフライト(OPTIONS)は Lambda Authorizer を通さず Lambda に届く必要がある。
 * API Gateway 側で OPTIONS を authorizationType=NONE で Lambda 統合する
 * （packages/cdk/lib/constructs/api.ts）。
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
