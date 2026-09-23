import * as path from 'node:path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

const API_SRC = path.join(__dirname, '..', '..', '..', 'api', 'src');

export interface ApiProps {
  readonly authorizer: apigateway.IAuthorizer;
  /** CORS で許可するオリジンの明示リスト（Hono の cors ミドルウェアへ渡す） */
  readonly allowedOrigins: readonly string[];
}

/**
 * API Gateway (REST) + Lambda-lith(Hono)。
 * - ANY /{proxy+} を Lambda proxy 統合
 * - context.authorizer.tenantId を X-Amz-Tenant-Id へマッピング
 * オリジン保護（X-Origin-Verify 検証）は Lambda Authorizer 側で行う
 * （API Gateway リソースポリシーは任意 HTTP ヘッダーを条件評価できないため）。
 */
export class Api extends Construct {
  readonly restApi: apigateway.RestApi;
  readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    this.handler = new NodejsFunction(this, 'Handler', {
      entry: path.join(API_SRC, 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(29),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'HandlerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      // テナント分離モード（関数作成時のみ設定可能）。テナント単位に実行環境を分離する。
      tenancyConfig: lambda.TenancyConfig.PER_TENANT,
      environment: {
        // Hono の CORS ミドルウェアが参照する許可オリジンの明示リスト。
        // 実リクエスト(GET等)のレスポンスに Access-Control-Allow-Origin を付ける。
        // プリフライト(OPTIONS)は API Gateway の MOCK 統合で返す（下記）。
        ALLOWED_ORIGINS: props.allowedOrigins.join(','),
      },
    });

    // 明示的な全許可リソースポリシー。
    // 以前は X-Origin-Verify を条件評価する DENY を置いていたが、リソース
    // ポリシーは任意 HTTP ヘッダーを参照できないため無効だった。オリジン保護は
    // Lambda Authorizer に移譲済み。ここで全許可を明示することで、旧ポリシーを
    // CloudFormation に確実に上書き削除させる（props から外すだけでは残存するため）。
    const policy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*'],
        }),
      ],
    });

    this.restApi = new apigateway.RestApi(this, 'RestApi', {
      restApiName: `${Stack.of(this).stackName}-api`,
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      policy,
      deployOptions: {
        stageName: 'v1',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
      },
    });

    const integration = new apigateway.LambdaIntegration(this.handler, {
      proxy: true,
      // context.authorizer.tenantId(JWT由来) を Lambda 分離モードの
      // X-Amz-Tenant-Id ヘッダーへマッピングする。分離モードの関数はこの
      // ヘッダーが無いと invocation が失敗する。
      requestParameters: {
        'integration.request.header.X-Amz-Tenant-Id':
          'context.authorizer.tenantId',
      },
    });

    const methodOptions: apigateway.MethodOptions = {
      authorizer: props.authorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    };

    // ANY /{proxy+} と ルート ANY を Hono に集約。
    const proxyResource = this.restApi.root.addResource('{proxy+}');
    proxyResource.addMethod('ANY', integration, methodOptions);
    this.restApi.root.addMethod('ANY', integration, methodOptions);

    // CORS プリフライト(OPTIONS)。MOCK 統合で API Gateway が直接応答する
    // （Lambda を呼ばない）。本体はテナント分離モードで X-Amz-Tenant-Id 必須
    // かつ OPTIONS は Authorizer を通せないため、Lambda に流さず MOCK で返す。
    // allowedOrigins を複数渡すと、CDK は Origin を許可リストと突き合わせて
    // 一致したオリジンだけ返す VTL を生成する（動的出し分け）。
    if (props.allowedOrigins.length > 0) {
      const corsPreflight: apigateway.CorsOptions = {
        allowOrigins: [...props.allowedOrigins],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: Duration.seconds(600),
      };
      proxyResource.addCorsPreflight(corsPreflight);
      this.restApi.root.addCorsPreflight(corsPreflight);
    }
  }
}
