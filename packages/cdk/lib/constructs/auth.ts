import * as path from 'node:path';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
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

export interface AuthProps {
  /** custom:tenantId 属性名（既定 custom:tenantId） */
  readonly tenantAttributeName?: string;
  /**
   * Hosted UI のデフォルトドメインのプレフィックス。
   * 指定時のみ User Pool Domain を作り、App Client に OAuth 設定を付ける。
   */
  readonly authDomainPrefix?: string;
  /**
   * Hosted UI のコールバック / ログアウト URL に使う SPA オリジン一覧。
   * 例: ["http://localhost:5173", "https://app.example.com"]
   */
  readonly callbackOrigins?: readonly string[];
}

/**
 * Cognito User Pool。カスタム属性 tenantId を持ち、
 * pre-token-generation trigger で ID トークンに tenantId を注入する。
 */
export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthProps = {}) {
    super(scope, id);

    const attributeName = props.tenantAttributeName ?? 'custom:tenantId';
    // カスタム属性の登録時はプレフィックス custom: を除いた名前を使う。
    const bareAttribute = attributeName.replace(/^custom:/, '');

    const preTokenFn = new NodejsFunction(this, 'PreTokenTrigger', {
      entry: path.join(AUTHORIZER_SRC, 'pre-token.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(5),
      logGroup: new logs.LogGroup(this, 'PreTokenTriggerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        TENANT_ATTRIBUTE: attributeName,
      },
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      customAttributes: {
        // テナント所属はサインアップ/管理者作成時に確定する不変属性。
        // mutable: true だとユーザーが UpdateUserAttributes で別テナントへ移動でき、
        // そのテナント用 JWT を取得できてしまうため false にする。
        [bareAttribute]: new cognito.StringAttribute({ mutable: false }),
      },
      lambdaTriggers: {
        preTokenGeneration: preTokenFn,
      },
    });

    // Hosted UI を使う場合、コールバック / ログアウト URL は SPA のオリジン。
    const callbackOrigins = props.callbackOrigins ?? [];
    const useHostedUi =
      Boolean(props.authDomainPrefix) && callbackOrigins.length > 0;

    this.userPoolClient = this.userPool.addClient('AppClient', {
      authFlows: {
        // SRP は残す（CLI 動作確認や自前フォーム用途）。Hosted UI とは併存できる。
        userSrp: true,
      },
      // Hosted UI（Authorization Code + PKCE）。SPA なので client secret は持たない。
      oAuth: useHostedUi
        ? {
            flows: { authorizationCodeGrant: true },
            scopes: [
              cognito.OAuthScope.OPENID,
              cognito.OAuthScope.EMAIL,
              cognito.OAuthScope.PROFILE,
            ],
            callbackUrls: [...callbackOrigins],
            logoutUrls: [...callbackOrigins],
          }
        : undefined,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // Hosted UI のデフォルトドメイン。ホスト名は
    // {prefix}.auth.{region}.amazoncognito.com。
    if (props.authDomainPrefix) {
      this.userPool.addDomain('HostedUiDomain', {
        cognitoDomain: { domainPrefix: props.authDomainPrefix },
      });
    }
  }
}
