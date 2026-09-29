import * as path from 'node:path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Duration, RemovalPolicy } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

const AUTHORIZER_SRC = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'authorizer',
  'src',
);

export interface AuthorizerProps {
  readonly userPool: cognito.IUserPool;
  /**
   * tenantId -> App Client。App-client per tenant 方式では各テナントが
   * 別々の App Client を持つ。Authorizer は全 clientId を許可しつつ、
   * トークンの aud がアクセス先テナントの App Client と一致するか突合する。
   */
  readonly userPoolClients: ReadonlyMap<string, cognito.IUserPoolClient>;
  /** CloudFront から付与されるオリジン検証シークレット。Authorizer 内で照合 */
  readonly originVerifySecret: secretsmanager.ISecret;
  /** custom:tenantId 属性名（既定 custom:tenantId） */
  readonly tenantClaim?: string;
  /** FunctionLogs の保持期間。未指定なら ONE_MONTH（30 日） */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * REQUEST 型 Lambda Authorizer。
 * - JWT 検証
 * - Host由来テナントIDとJWT由来テナントIDの一致検証
 * - テナント↔clientId（aud）の突合（App-client per tenant の多層防御）
 * - X-Origin-Verify（CloudFront が付与）とシークレットの一致検証（オリジン保護）
 * 認可コンテキストに JWT 由来の tenantId を返す。
 */
export class TenantAuthorizer extends Construct {
  readonly authorizer: apigateway.RequestAuthorizer;

  constructor(scope: Construct, id: string, props: AuthorizerProps) {
    super(scope, id);

    if (props.userPoolClients.size === 0) {
      throw new Error('userPoolClients を1つ以上指定してください');
    }

    // tenantId -> clientId の JSON。Authorizer 内で aud 突合に使う。
    const tenantClientMap: Record<string, string> = {};
    for (const [tenantId, client] of props.userPoolClients) {
      tenantClientMap[tenantId] = client.userPoolClientId;
    }

    const fn = new NodejsFunction(this, 'Function', {
      entry: path.join(AUTHORIZER_SRC, 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(10),
      logGroup: new logs.LogGroup(this, 'FunctionLogs', {
        retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        TENANT_CLIENT_MAP: JSON.stringify(tenantClientMap),
        TENANT_CLAIM: props.tenantClaim ?? 'custom:tenantId',
        ORIGIN_VERIFY_SECRET:
          props.originVerifySecret.secretValue.unsafeUnwrap(),
      },
    });

    this.authorizer = new apigateway.RequestAuthorizer(this, 'Authorizer', {
      handler: fn,
      // Authorization / X-Tenant-Id / X-Origin-Verify のいずれかが欠けると
      // API Gateway が Authorizer を呼ばず 401 を返す。
      identitySources: [
        apigateway.IdentitySource.header('Authorization'),
        apigateway.IdentitySource.header('X-Tenant-Id'),
        apigateway.IdentitySource.header('X-Origin-Verify'),
      ],
      // キャッシュ無効。Allow ポリシーの Resource は event.methodArn（メソッド単位）で
      // 返すため、キャッシュすると同じ identity source の組で別パスへ再利用され
      // Resource 不一致で 403 になる。テナント一致検証も毎リクエスト行う設計のため無効化する。
      resultsCacheTtl: Duration.seconds(0),
    });
  }
}
