import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { type BackendApiConfig, buildTenantClients } from './config';
import { Api } from './constructs/api';
import { Auth } from './constructs/auth';
import { TenantAuthorizer } from './constructs/authorizer';

export interface BackendStackProps extends StackProps {
  readonly config: BackendApiConfig;
}

/**
 * バックエンド（認証 / API）スタック。
 * Cognito(Auth) / Lambda オーソライザー(Authorizer) / API Gateway(Api) と、
 * CloudFront → API Gateway のオリジン検証シークレット(OriginVerifySecret) を持つ。
 * フロントエンド配信スタック(FrontendStack)へは restApi と originVerifySecret を
 * props（同一 app 内の cross-stack 参照）として渡す。
 */
/** テナント1件分の公開設定（フロントが起動時に取得する値）。 */
export interface TenantPublicConfig {
  readonly tenantId: string;
  /** Cognito User Pool ID（トークン。cross-stack 参照される） */
  readonly userPoolId: string;
  /** そのテナントの App Client ID（トークン。cross-stack 参照される） */
  readonly userPoolClientId: string;
}

export class BackendStack extends Stack {
  /** フロントエンドスタックが CloudFront オリジンとして参照する REST API */
  readonly restApi: apigateway.RestApi;
  /** CloudFront オリジン検証シークレット（Edge のカスタムヘッダーで共有） */
  readonly originVerifySecret: secretsmanager.ISecret;
  /**
   * テナントごとの公開設定。FrontendStack の Edge が CloudFront Function
   * (tenant-config.js) に焼き込み、/tenant-config.json で返す。
   */
  readonly tenantPublicConfigs: readonly TenantPublicConfig[];

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    const { config } = props;

    // CloudFront → API Gateway のオリジン検証シークレット。
    const originVerifySecret = new secretsmanager.Secret(
      this,
      'OriginVerifySecret',
      {
        description:
          'Shared secret to verify requests originate from CloudFront',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 32,
        },
      },
    );

    // App-client per tenant: テナントごとに callback を限定した App Client を作る。
    const tenantClients = buildTenantClients(config);

    const auth = new Auth(this, 'Auth', {
      authDomainPrefix: config.authDomainPrefix,
      tenantClients,
    });

    const authorizer = new TenantAuthorizer(this, 'Authorizer', {
      userPool: auth.userPool,
      userPoolClients: auth.userPoolClients,
      originVerifySecret,
    });

    const api = new Api(this, 'Api', {
      authorizer: authorizer.authorizer,
      allowedOrigins: config.allowedOrigins,
    });

    this.restApi = api.restApi;
    this.originVerifySecret = originVerifySecret;
    this.tenantPublicConfigs = Array.from(auth.userPoolClients).map(
      ([tenantId, client]) => ({
        tenantId,
        userPoolId: auth.userPool.userPoolId,
        userPoolClientId: client.userPoolClientId,
      }),
    );

    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    // テナントごとに App Client ID を出力する。フロントは自テナントの
    // clientId を使う（例: UserPoolClientIdtenanta）。
    for (const [tenantId, client] of auth.userPoolClients) {
      new CfnOutput(this, `UserPoolClientId-${tenantId}`, {
        value: client.userPoolClientId,
        description: `App Client ID for tenant ${tenantId}`,
      });
    }
    if (config.authDomainPrefix) {
      new CfnOutput(this, 'HostedUiDomain', {
        value: `${config.authDomainPrefix}.auth.${this.region}.amazoncognito.com`,
      });
    }
    new CfnOutput(this, 'RestApiId', { value: api.restApi.restApiId });
  }
}
