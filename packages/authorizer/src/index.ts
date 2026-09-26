import type {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
  PolicyDocument,
} from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const USER_POOL_ID = requireEnv('USER_POOL_ID');
const ORIGIN_VERIFY_SECRET = requireEnv('ORIGIN_VERIFY_SECRET');
const TENANT_CLAIM = process.env.TENANT_CLAIM ?? 'custom:tenantId';

// tenantId -> App Client ID のマップ（JSON）。App-client per tenant 方式では
// テナントごとに App Client を持つため、どのテナントがどの clientId かを突合する。
// 例: {"app":"abc123","acme":"def456"}
const TENANT_CLIENT_MAP = parseTenantClientMap(requireEnv('TENANT_CLIENT_MAP'));
const ALLOWED_CLIENT_IDS = Object.values(TENANT_CLIENT_MAP);

// verifier は初期化フェーズで一度だけ生成し、JWKS をキャッシュする。
// clientId には全テナントの App Client を許可し、テナント↔clientId の厳密突合は
// verify 後に自前で行う（下記）。
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  clientId: ALLOWED_CLIENT_IDS,
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

    // (1) JWT 由来のテナントIDと Host 由来のテナントIDが一致しなければ拒否。
    if (typeof jwtTenantId !== 'string' || jwtTenantId !== hostTenantId) {
      return deny(event);
    }

    // (2) テナント↔clientId の突合。トークンを発行した App Client が、その
    // テナントに割り当てられた App Client か検証する。App-client per tenant の
    // 多層防御: 仮に別テナントの App Client で発行されたトークンでも、aud が
    // 一致しなければここで弾く。
    const expectedClientId = TENANT_CLIENT_MAP[jwtTenantId];
    if (!expectedClientId || payload.aud !== expectedClientId) {
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

function policy(effect: 'Allow' | 'Deny', resource: string): PolicyDocument {
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

function parseTenantClientMap(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TENANT_CLIENT_MAP must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'TENANT_CLIENT_MAP must be a JSON object of tenantId->clientId',
    );
  }
  const map: Record<string, string> = {};
  for (const [tenantId, clientId] of Object.entries(parsed)) {
    if (typeof clientId !== 'string' || clientId.length === 0) {
      throw new Error(
        `TENANT_CLIENT_MAP["${tenantId}"] must be a non-empty string`,
      );
    }
    map[tenantId] = clientId;
  }
  if (Object.keys(map).length === 0) {
    throw new Error('TENANT_CLIENT_MAP must have at least one entry');
  }
  return map;
}
