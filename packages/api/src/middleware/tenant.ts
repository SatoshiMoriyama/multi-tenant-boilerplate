import type { MiddlewareHandler } from 'hono';
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';

export type TenantEnv = {
  Variables: {
    tenantId: string;
  };
  Bindings: {
    event: LambdaEvent;
    lambdaContext: LambdaContext;
  };
};

/**
 * Lambda Authorizer が返した認可コンテキストから tenantId を取り出し、
 * Hono の context 変数に載せる。API Gateway REST API の proxy 統合では
 * requestContext.authorizer に載る。詐称不可（JWT 検証済みの値）。
 */
export const tenantContext = (): MiddlewareHandler<TenantEnv> => {
  return async (c, next) => {
    // requestContext は API Gateway/ALB などの union のため、
    // authorizer を持つ形にだけ絞り込んで参照する。
    const requestContext = c.env?.event?.requestContext as
      | { authorizer?: Record<string, unknown> | null }
      | undefined;
    const tenantId = requestContext?.authorizer?.tenantId;

    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      return c.json({ message: 'Tenant context missing' }, 403);
    }

    c.set('tenantId', tenantId);
    await next();
  };
};
