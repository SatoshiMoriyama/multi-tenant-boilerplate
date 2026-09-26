import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import type { BackendApiConfig } from './config';
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
export class BackendStack extends Stack {
  /** フロントエンドスタックが CloudFront オリジンとして参照する REST API */
  readonly restApi: apigateway.RestApi;
  /** CloudFront オリジン検証シークレット（Edge のカスタムヘッダーで共有） */
  readonly originVerifySecret: secretsmanager.ISecret;

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

    const auth = new Auth(this, 'Auth', {
      authDomainPrefix: config.authDomainPrefix,
      callbackOrigins: config.allowedOrigins,
    });

    const authorizer = new TenantAuthorizer(this, 'Authorizer', {
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      originVerifySecret,
    });

    const api = new Api(this, 'Api', {
      authorizer: authorizer.authorizer,
      allowedOrigins: config.allowedOrigins,
    });

    this.restApi = api.restApi;
    this.originVerifySecret = originVerifySecret;

    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', {
      value: auth.userPoolClient.userPoolClientId,
    });
    if (config.authDomainPrefix) {
      new CfnOutput(this, 'HostedUiDomain', {
        value: `${config.authDomainPrefix}.auth.${this.region}.amazoncognito.com`,
      });
    }
    new CfnOutput(this, 'RestApiId', { value: api.restApi.restApiId });
  }
}
