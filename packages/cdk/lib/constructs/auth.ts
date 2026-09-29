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

/** テナント1件分の App Client 構成入力。 */
export interface TenantClientConfig {
  /** テナント識別子（custom:tenantId と一致させる。例: "app"） */
  readonly tenantId: string;
  /**
   * このテナントの Hosted UI コールバック / ログアウト URL に使うオリジン一覧。
   * 通常はそのテナントのサブドメイン（例: https://app.example.com）。
   * 開発用に http://localhost:5173 を含めてもよい。
   */
  readonly callbackOrigins: readonly string[];
}

export interface AuthProps {
  /** custom:tenantId 属性名（既定 custom:tenantId） */
  readonly tenantAttributeName?: string;
  /**
   * Hosted UI のデフォルトドメインのプレフィックス。
   * 指定時のみ User Pool Domain を作り、各 App Client に OAuth 設定を付ける。
   */
  readonly authDomainPrefix?: string;
  /**
   * テナントごとの App Client 構成。App-client per tenant 方式では
   * テナント数ぶんの App Client を作り、callback をテナントのオリジンに限定する。
   * 空だと App Client を1つも作らない（誤設定なので synth 時に落とす）。
   */
  readonly tenantClients: readonly TenantClientConfig[];
  /** PreTokenTriggerLogs の保持期間。未指定なら ONE_MONTH（30 日） */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * Cognito User Pool。カスタム属性 tenantId を持ち、
 * pre-token-generation trigger で ID トークンに tenantId を注入する。
 *
 * App-client per tenant 方式: テナントごとに App Client を1つ作り、Hosted UI の
 * callback/logout をそのテナントのオリジンに限定する。これにより他テナントの
 * ドメインへリダイレクトさせられない。ただし同一 User Pool 内では Hosted UI の
 * セッション Cookie が共有されるため、「別テナントで再入力なしにトークンが出る」
 * という体験自体は App Client 分離だけでは消えない（フロント側の tenantId 一致
 * 検証で塞ぐ）。
 */
export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  /** tenantId -> App Client。Authorizer のテナント↔clientId 突合に使う。 */
  readonly userPoolClients: ReadonlyMap<string, cognito.UserPoolClient>;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);

    const attributeName = props.tenantAttributeName ?? 'custom:tenantId';
    // カスタム属性の登録時はプレフィックス custom: を除いた名前を使う。
    const bareAttribute = attributeName.replace(/^custom:/, '');

    if (props.tenantClients.length === 0) {
      throw new Error(
        'tenantClients を1つ以上指定してください（App Client per tenant のため、テナントごとに App Client を作ります）',
      );
    }

    const preTokenFn = new NodejsFunction(this, 'PreTokenTrigger', {
      entry: path.join(AUTHORIZER_SRC, 'pre-token.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(5),
      logGroup: new logs.LogGroup(this, 'PreTokenTriggerLogs', {
        retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
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

    const useHostedUi = Boolean(props.authDomainPrefix);

    // テナントごとに App Client を作る。callback はそのテナントのオリジンに限定。
    const clients = new Map<string, cognito.UserPoolClient>();
    for (const tenant of props.tenantClients) {
      // authDomainPrefix を指定したのに callback URL が空だと、ドメインはできるが
      // OAuth 設定が付かずログインできない中途半端な構成になる。設定ミスを
      // サイレントに通さず synth 時に落とす。
      if (useHostedUi && tenant.callbackOrigins.length === 0) {
        throw new Error(
          `テナント "${tenant.tenantId}" の callbackOrigins が空です。authDomainPrefix を指定する場合は各テナントに1つ以上の callbackOrigins が必要です（Hosted UI のコールバックURLに使います）`,
        );
      }

      const client = this.userPool.addClient(`AppClient-${tenant.tenantId}`, {
        userPoolClientName: `tenant-${tenant.tenantId}`,
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
              callbackUrls: [...tenant.callbackOrigins],
              logoutUrls: [...tenant.callbackOrigins],
            }
          : undefined,
        idTokenValidity: Duration.hours(1),
        accessTokenValidity: Duration.hours(1),
        refreshTokenValidity: Duration.days(30),
        preventUserExistenceErrors: true,
      });
      clients.set(tenant.tenantId, client);
    }
    this.userPoolClients = clients;

    // Hosted UI のデフォルトドメイン。ホスト名は
    // {prefix}.auth.{region}.amazoncognito.com。
    // ドメイン作成と OAuth 設定は同じ条件（useHostedUi）にする。片方だけ作ると
    // 「ドメインはあるが OAuth 未設定でログインできない」中途半端な構成になるため。
    if (useHostedUi) {
      this.userPool.addDomain('HostedUiDomain', {
        cognitoDomain: { domainPrefix: props.authDomainPrefix as string },
      });
    }
  }
}
