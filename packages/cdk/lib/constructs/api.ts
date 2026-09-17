import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

const API_SRC = path.join(__dirname, '..', '..', '..', 'api', 'src');

export interface ApiProps {
  readonly authorizer: apigateway.IAuthorizer;
  /** Lambda テナント分離モードを有効化するか */
  readonly enableTenantIsolation: boolean;
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
      // テナント分離モードは関数作成時のみ設定可能。有効時のみ付与。
      tenancyConfig: props.enableTenantIsolation ? lambda.TenancyConfig.PER_TENANT : undefined,
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
      // テナント分離モード有効時のみ X-Amz-Tenant-Id を付与する。
      // 分離モード OFF の Lambda にこのヘッダーを送ると 400 になるため、
      // Basic(pooled) ではマッピングしない（テナント分離は Hono middleware で論理的に行う）。
      requestParameters: props.enableTenantIsolation
        ? {
            // context.authorizer.tenantId(JWT由来) を Lambda 分離モードの
            // X-Amz-Tenant-Id ヘッダーへマッピングする。
            'integration.request.header.X-Amz-Tenant-Id': 'context.authorizer.tenantId',
          }
        : undefined,
    });

    const methodOptions: apigateway.MethodOptions = {
      authorizer: props.authorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    };

    // ANY /{proxy+} と ルート ANY を Hono に集約。
    const proxyResource = this.restApi.root.addResource('{proxy+}');
    proxyResource.addMethod('ANY', integration, methodOptions);
    this.restApi.root.addMethod('ANY', integration, methodOptions);
  }
}
