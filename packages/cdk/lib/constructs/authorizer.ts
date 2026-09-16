import * as path from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

const AUTHORIZER_SRC = path.join(__dirname, '..', '..', '..', 'authorizer', 'src');

export interface AuthorizerProps {
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  /** CloudFront から付与されるオリジン検証シークレット。Authorizer 内で照合 */
  readonly originVerifySecret: secretsmanager.ISecret;
  /** custom:tenantId 属性名（既定 custom:tenantId） */
  readonly tenantClaim?: string;
}

/**
 * REQUEST 型 Lambda Authorizer。
 * - JWT 検証
 * - Host由来テナントIDとJWT由来テナントIDの一致検証
 * - X-Origin-Verify（CloudFront が付与）とシークレットの一致検証（オリジン保護）
 * 認可コンテキストに JWT 由来の tenantId を返す。
 */
export class TenantAuthorizer extends Construct {
  readonly authorizer: apigateway.RequestAuthorizer;

  constructor(scope: Construct, id: string, props: AuthorizerProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Function', {
      entry: path.join(AUTHORIZER_SRC, 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(10),
      logGroup: new logs.LogGroup(this, 'FunctionLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
        TENANT_CLAIM: props.tenantClaim ?? 'custom:tenantId',
        ORIGIN_VERIFY_SECRET: props.originVerifySecret.secretValue.unsafeUnwrap(),
      },
    });

    this.authorizer = new apigateway.RequestAuthorizer(this, 'Authorizer', {
      handler: fn,
      // Authorization / X-Tenant-Id / X-Origin-Verify の組でキャッシュ。
      // いずれかが欠けると API Gateway が Authorizer を呼ばず 401 を返す。
      identitySources: [
        apigateway.IdentitySource.header('Authorization'),
        apigateway.IdentitySource.header('X-Tenant-Id'),
        apigateway.IdentitySource.header('X-Origin-Verify'),
      ],
      resultsCacheTtl: Duration.minutes(5),
    });
  }
}
