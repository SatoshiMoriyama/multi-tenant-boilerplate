import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
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
 *
 * 1テナント1オリジン（例 app.example.com）に SPA と API を同居させる。
 * - default behavior: SPA(S3) を配信
 * - /api/* behavior: API Gateway へ。tenant-resolver Function と X-Origin-Verify を付与
 */
export class Edge extends Construct {
  /** 親ディストリビューションID（子テナントが参照） */
  readonly distributionId: string;
  readonly tenantResolver: cloudfront.Function;
  /** SPA アセットを置く S3 バケット（web の dist をデプロイする先） */
  readonly siteBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const apiOriginId = 'ApiOrigin';
    const siteOriginId = 'SiteOrigin';

    // Host から X-Tenant-Id を付与する CloudFront Function（viewer-request）。
    // CloudFront Function は実行時に環境変数を持てないため、config.baseDomain を
    // デプロイ時にコードへ焼き込む（設定の単一ソース化）。
    const resolverPath = path.join(
      __dirname,
      '..',
      'functions',
      'tenant-resolver.js',
    );
    const resolverCode = readFileSync(resolverPath, 'utf-8').replaceAll(
      '__BASE_DOMAIN__',
      props.baseDomain,
    );
    this.tenantResolver = new cloudfront.Function(this, 'TenantResolver', {
      code: cloudfront.FunctionCode.fromInline(resolverCode),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // SPA アセット用 S3 バケット。パブリックアクセスは全面ブロックし、
    // CloudFront の OAC 経由でのみ読ませる。
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Origin Access Control（SigV4）。OAI ではなく OAC を使う。
    const oac = new cloudfront.CfnOriginAccessControl(this, 'SiteOac', {
      originAccessControlConfig: {
        name: `${stack.stackName}-site-oac`,
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    // REST API のオリジンドメインとパス。
    const apiOriginDomain = `${props.restApi.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
    const apiOriginPath = `/${props.restApi.deploymentStage.stageName}`;

    // S3 のリージョナルドメイン（OAC は仮想ホスト形式のリージョナルエンドポイントが必要）。
    const siteOriginDomain = this.siteBucket.bucketRegionalDomainName;

    const distribution = new cloudfront.CfnDistribution(this, 'MultiTenant', {
      distributionConfig: {
        enabled: true,
        // マルチテナント（SaaS Manager）ディストリビューション。
        connectionMode: 'tenant-only',
        // SPA のエントリ。ルート ("/") アクセスで index.html を返す。
        defaultRootObject: 'index.html',
        origins: [
          // API Gateway オリジン（/api/* 用）。
          {
            id: apiOriginId,
            domainName: apiOriginDomain,
            originPath: apiOriginPath,
            customOriginConfig: {
              originProtocolPolicy: 'https-only',
              originSslProtocols: ['TLSv1.2'],
            },
            originCustomHeaders: [
              {
                headerName: 'X-Origin-Verify',
                headerValue:
                  props.originVerifySecret.secretValue.unsafeUnwrap(),
              },
            ],
          },
          // S3 オリジン（SPA 配信用）。OAC を関連付ける。
          {
            id: siteOriginId,
            domainName: siteOriginDomain,
            s3OriginConfig: { originAccessIdentity: '' },
            originAccessControlId: oac.attrId,
          },
        ],
        // 既定は SPA(S3)。静的アセットはキャッシュ最適化。
        defaultCacheBehavior: {
          targetOriginId: siteOriginId,
          viewerProtocolPolicy: 'redirect-to-https',
          cachePolicyId: cloudfront.CachePolicy.CACHING_OPTIMIZED.cachePolicyId,
          allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
        },
        cacheBehaviors: [
          // /api/* は API Gateway へ。認証付きAPIはキャッシュ無効。
          // Authorization/X-Tenant-Id を転送し、tenant-resolver で X-Tenant-Id を付与。
          {
            pathPattern: '/api/*',
            targetOriginId: apiOriginId,
            viewerProtocolPolicy: 'redirect-to-https',
            cachePolicyId:
              cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
            originRequestPolicyId:
              cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER
                .originRequestPolicyId,
            allowedMethods: [
              'GET',
              'HEAD',
              'OPTIONS',
              'PUT',
              'PATCH',
              'POST',
              'DELETE',
            ],
            functionAssociations: [
              {
                eventType: 'viewer-request',
                functionArn: this.tenantResolver.functionArn,
              },
            ],
          },
        ],
        // SPA フォールバック。S3 が 403/404 を返すディープリンクは index.html を
        // 200 で返し、クライアントルーティングに委ねる。
        customErrorResponses: [
          {
            errorCode: 403,
            responseCode: 200,
            responsePagePath: '/index.html',
          },
          {
            errorCode: 404,
            responseCode: 200,
            responsePagePath: '/index.html',
          },
        ],
        viewerCertificate: {
          acmCertificateArn: props.certificateArn,
          sslSupportMethod: 'sni-only',
          minimumProtocolVersion: 'TLSv1.2_2021',
        },
      },
    });

    this.distributionId = distribution.ref;

    // S3 バケットポリシー: この CloudFront ディストリビューションからの
    // OAC 経由アクセスのみ許可する。
    this.siteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.siteBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:${stack.partition}:cloudfront::${stack.account}:distribution/${distribution.ref}`,
          },
        },
      }),
    );

    // web のビルド成果物(dist)を S3 へ配置する。cdk deploy 前に web をビルド
    // しておくこと（ルートの cdk:deploy が web:build を先に走らせる）。
    // 無効化は行わない（A 方針）。ハッシュ付きアセット + no-cache な index.html の
    // 組み合わせで、次回アクセス時に新しい index.html が新ハッシュのアセットを取りに行く。
    const distDir = path.join(__dirname, '..', '..', '..', 'web', 'dist');
    if (!existsSync(path.join(distDir, 'index.html'))) {
      throw new Error(
        `web の dist が見つからない（${distDir}）。cdk deploy 前に web をビルドすること` +
          `（例: pnpm --filter web build、またはルートの pnpm cdk:deploy）。`,
      );
    }

    // アセット（index.html 以外）: 長期キャッシュ・immutable。
    // ハッシュ付きファイル名なので内容が変わればファイル名も変わる。
    new s3deploy.BucketDeployment(this, 'SiteAssetsDeployment', {
      sources: [s3deploy.Source.asset(distDir, { exclude: ['index.html'] })],
      destinationBucket: this.siteBucket,
      cacheControl: [
        s3deploy.CacheControl.maxAge(Duration.days(365)),
        s3deploy.CacheControl.immutable(),
      ],
      // 同一バケットへ複数デプロイするため prune は無効（互いのファイルを消さない）。
      prune: false,
    });

    // index.html: no-cache。SPA のエントリなので毎回再検証させ、更新を即反映する。
    new s3deploy.BucketDeployment(this, 'SiteHtmlDeployment', {
      sources: [
        s3deploy.Source.asset(distDir, { exclude: ['*', '!index.html'] }),
      ],
      destinationBucket: this.siteBucket,
      cacheControl: [s3deploy.CacheControl.noCache()],
      prune: false,
    });
  }
}
