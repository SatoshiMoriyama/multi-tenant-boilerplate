import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { Stack } from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface EdgeProps {
  readonly restApi: apigateway.RestApi;
  readonly baseDomain: string;
  /** 既存のワイルドカード ACM 証明書 ARN（us-east-1） */
  readonly certificateArn: string;
  /** CloudFront がオリジンへ付与する検証シークレット */
  readonly originVerifySecret: secretsmanager.ISecret;
}

/**
 * CloudFront マルチテナントディストリビューション（親）と CloudFront Function。
 * 親は connectionMode=tenant-only。子(distribution tenant)は tenants.ts で作成する。
 */
export class Edge extends Construct {
  /** 親ディストリビューションID（子テナントが参照） */
  readonly distributionId: string;
  readonly tenantResolver: cloudfront.Function;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const originId = 'ApiOrigin';

    // Host から X-Tenant-Id を付与する CloudFront Function（viewer-request）。
    // CloudFront Function は実行時に環境変数を持てないため、config.baseDomain を
    // デプロイ時にコードへ焼き込む（設定の単一ソース化）。
    const resolverPath = path.join(__dirname, '..', 'functions', 'tenant-resolver.js');
    const resolverCode = readFileSync(resolverPath, 'utf-8').replaceAll(
      '__BASE_DOMAIN__',
      props.baseDomain,
    );
    this.tenantResolver = new cloudfront.Function(this, 'TenantResolver', {
      code: cloudfront.FunctionCode.fromInline(resolverCode),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // REST API のオリジンドメインとパス。
    const originDomain = `${props.restApi.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
    const originPath = `/${props.restApi.deploymentStage.stageName}`;

    const distribution = new cloudfront.CfnDistribution(this, 'MultiTenant', {
      distributionConfig: {
        enabled: true,
        // マルチテナント（SaaS Manager）ディストリビューション。
        // オリジンは全テナント共通の API Gateway 固定のため、テナント別
        // パラメータ（parameterDefinitions）は定義しない。
        connectionMode: 'tenant-only',
        origins: [
          {
            id: originId,
            domainName: originDomain,
            originPath,
            customOriginConfig: {
              originProtocolPolicy: 'https-only',
              originSslProtocols: ['TLSv1.2'],
            },
            originCustomHeaders: [
              {
                headerName: 'X-Origin-Verify',
                headerValue: props.originVerifySecret.secretValue.unsafeUnwrap(),
              },
            ],
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: originId,
          viewerProtocolPolicy: 'redirect-to-https',
          // 認証付きAPIはキャッシュ無効。Authorization/X-Tenant-Id を転送。
          cachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
          originRequestPolicyId:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
          allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
          functionAssociations: [
            {
              eventType: 'viewer-request',
              functionArn: this.tenantResolver.functionArn,
            },
          ],
        },
        viewerCertificate: {
          acmCertificateArn: props.certificateArn,
          sslSupportMethod: 'sni-only',
          minimumProtocolVersion: 'TLSv1.2_2021',
        },
      },
    });

    this.distributionId = distribution.ref;
  }
}
