import type {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
  PolicyDocument,
} from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const USER_POOL_ID = requireEnv('USER_POOL_ID');
const CLIENT_ID = requireEnv('USER_POOL_CLIENT_ID');
const ORIGIN_VERIFY_SECRET = requireEnv('ORIGIN_VERIFY_SECRET');
const TENANT_CLAIM = process.env.TENANT_CLAIM ?? 'custom:tenantId';

// verifier は初期化フェーズで一度だけ生成し、JWKS をキャッシュする。
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  clientId: CLIENT_ID,
  tokenUse: 'id',
});

export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  // オリジン保護: CloudFront が付与する X-Origin-Verify を検証。
  // 直アクセスやシークレット不一致はここで拒否（CloudFront 経由のみ許可）。
  const originVerify = getHeader(event, 'X-Origin-Verify');
  if (originVerify !== ORIGIN_VERIFY_SECRET) {
    return deny(event);
  }

  const token = extractBearerToken(event);
  const hostTenantId = getHeader(event, 'X-Tenant-Id');

  if (!token || !hostTenantId) {
    return deny(event);
  }

  try {
    const payload = await verifier.verify(token);
    const jwtTenantId = payload[TENANT_CLAIM];

    // JWT 由来のテナントIDと Host 由来のテナントIDが一致しなければ拒否。
    if (typeof jwtTenantId !== 'string' || jwtTenantId !== hostTenantId) {
      return deny(event);
    }

    // 下流には JWT 由来（詐称不可）の値だけを渡す。
    return allow(event, String(payload.sub), jwtTenantId);
  } catch (err) {
    console.error('JWT verification failed', err);
    return deny(event);
  }
};

function extractBearerToken(
  event: APIGatewayRequestAuthorizerEvent,
): string | undefined {
  const header = getHeader(event, 'Authorization');
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function getHeader(
  event: APIGatewayRequestAuthorizerEvent,
  name: string,
): string | undefined {
  const headers = event.headers ?? {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return undefined;
}

function allow(
  event: APIGatewayRequestAuthorizerEvent,
  principalId: string,
  tenantId: string,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: policy('Allow', event.methodArn),
    context: { tenantId },
  };
}

function deny(
  event: APIGatewayRequestAuthorizerEvent,
): APIGatewayAuthorizerResult {
  return {
    principalId: 'unauthorized',
    policyDocument: policy('Deny', event.methodArn),
  };
}

function policy(
  effect: 'Allow' | 'Deny',
  resource: string,
): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: resource,
      },
    ],
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
