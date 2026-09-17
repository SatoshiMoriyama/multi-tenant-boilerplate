import * as path from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
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

    this.userPoolClient = this.userPool.addClient('AppClient', {
      authFlows: {
        userSrp: true,
      },
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });
  }
}
