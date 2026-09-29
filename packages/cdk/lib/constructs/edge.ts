import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Annotations, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

/** tenant-config.js に焼き込むテナント1件分の公開設定。 */
export interface EdgeTenantPublicConfig {
  readonly tenantId: string;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
}

export interface EdgeProps {
  readonly restApi: apigateway.RestApi;
  readonly baseDomain: string;
  /** 既存のワイルドカード ACM 証明書 ARN（us-east-1） */
  readonly certificateArn: string;
  /** CloudFront がオリジンへ付与する検証シークレット */
  readonly originVerifySecret: secretsmanager.ISecret;
  /** テナントごとの公開設定（/tenant-config.json で返す） */
  readonly tenantPublicConfigs: readonly EdgeTenantPublicConfig[];
  /** Cognito Hosted UI ドメイン（全テナント共通）。未設定なら空文字で焼き込む */
  readonly hostedUiDomain?: string;
}

/**
 * CloudFront マルチテナントディストリビューション（親）と CloudFront Function。
 * 親は connectionMode=tenant-only。子(distribution tenant)は tenants.ts で作成する。
 *
 * 1テナント1オリジン（例 app.example.com）に SPA と API を同居させる。
 * - default behavior: SPA(S3) を配信。spa-router Function でディープリンクを index.html に書き換える
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

    // SPA のディープリンクを /index.html に書き換える CloudFront Function（viewer-request）。
    // default behavior(SPA/S3)にのみ関連付け、既知の静的拡張子で終わらない URI を
    // SPA エントリへ振る（ドットを含むルート /reports/2024.q1 等も取りこぼさない）。
    // 関数側でも /api/* を明示的に素通しするため、API の 403/404 は本来の JSON エラーのまま返る。
    const spaRouterPath = path.join(
      __dirname,
      '..',
      'functions',
      'spa-router.js',
    );
    const spaRouterCode = readFileSync(spaRouterPath, 'utf-8');
    const spaRouter = new cloudfront.Function(this, 'SpaRouter', {
      code: cloudfront.FunctionCode.fromInline(spaRouterCode),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // /tenant-config.json を動的生成して返す CloudFront Function（viewer-request）。
    // Host からテナントを解決し、そのテナント分の公開設定（clientId 等）だけを
    // JSON で早期レスポンスする。オリジンには行かない。列挙されないよう Host に
    // 対応する1件のみ返す（tenant-config.js のコメント参照）。
    //
    // tenant→設定のマップは baseDomain と同じくコードへ焼き込む。ただし
    // userPoolId / userPoolClientId は CloudFormation トークン（cross-stack 参照）の
    // ため、JSON.stringify（JS 文字列）では解決できない。トークンを保持したまま
    // JSON を組み立てるため、CDK の文字列トークン連結（tokenizedMapLiteral）で
    // オブジェクトリテラルを作り、__TENANT_CLIENT_MAP__ を置換する。CDK は
    // トークンを含む最終文字列を Fn::Join に変換し、デプロイ時に解決する。
    const tenantConfigPath = path.join(
      __dirname,
      '..',
      'functions',
      'tenant-config.js',
    );
    const tenantConfigTemplate = readFileSync(tenantConfigPath, 'utf-8');
    const tenantMapLiteral = buildTenantMapLiteral(
      props.tenantPublicConfigs,
      props.hostedUiDomain ?? '',
    );
    const tenantConfigCode = tenantConfigTemplate
      .replaceAll('__BASE_DOMAIN__', props.baseDomain)
      .replaceAll('__TENANT_CLIENT_MAP__', tenantMapLiteral);
    const tenantConfig = new cloudfront.Function(this, 'TenantConfig', {
      code: cloudfront.FunctionCode.fromInline(tenantConfigCode),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // SPA アセット用 S3 バケット。パブリックアクセスは全面ブロックし、
    // CloudFront の OAC 経由でのみ読ませる。
    //
    // ライフサイクルは未完了マルチパートアップロードの中止のみ設定する。
    // このバケットはバージョニングを有効にしていないため、
    // noncurrentVersionExpiration と expiredObjectDeleteMarker は
    // 対象となるオブジェクトが存在せず効果がない。意図的に設定しない。
    //
    // なお prune: false（後述の BucketDeployment）により、ハッシュ名が変わった
    // 旧アセットは現行オブジェクトとして残り続ける。これはバージョンではないため
    // 上記2ルールでは削除できない。現行オブジェクトの期限切れは、参照中のアセットを
    // 消してサイトを壊す恐れがあるため、ここでは扱わない。
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'abort-incomplete-multipart-upload',
          enabled: true,
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
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
    // 不変条件: ここで使う region / urlSuffix は Stack.of(this)（= FrontendStack）の値
    // であり、API 本体が属する BackendStack のものではない。restApiId はスタック間参照で
    // 正しく import されるが、region / urlSuffix はローカルに解決されるため、この
    // オリジンドメインが正しいのは FrontendStack と BackendStack が同一リージョンを
    // 共有している場合に限られる（bin/cdk.ts が両スタックへ同じ env を渡すことで担保）。
    // 将来フロントとバックエンドを別リージョンへ分割する場合は、synth 時に失敗せず
    // 誤ったリージョンの execute-api エンドポイントを指すことになるため、API 側の
    // region / urlSuffix を props で明示的に受け取る形へ変更すること。
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
        // spa-router を viewer-request で関連付け、ディープリンクを /index.html に書き換える。
        defaultCacheBehavior: {
          targetOriginId: siteOriginId,
          viewerProtocolPolicy: 'redirect-to-https',
          cachePolicyId: cloudfront.CachePolicy.CACHING_OPTIMIZED.cachePolicyId,
          allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
          functionAssociations: [
            {
              eventType: 'viewer-request',
              functionArn: spaRouter.functionArn,
            },
          ],
        },
        cacheBehaviors: [
          // /tenant-config.json は tenant-config Function が viewer-request で
          // 早期レスポンスする（オリジンには行かない）。targetOriginId は形式上
          // 必須なので S3 を指すが、Function が return response するため未使用。
          // Host ごとに内容が変わるためキャッシュ無効。
          {
            pathPattern: '/tenant-config.json',
            targetOriginId: siteOriginId,
            viewerProtocolPolicy: 'redirect-to-https',
            cachePolicyId:
              cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
            allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            functionAssociations: [
              {
                eventType: 'viewer-request',
                functionArn: tenantConfig.functionArn,
              },
            ],
          },
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
        // SPA フォールバックは default behavior の spa-router(viewer-request)で行う。
        // ディストリビューション全体に効く customErrorResponses は使わない。
        // これにより /api/* の 403/404 は index.html に差し替わらず、本来の JSON エラーを返す。
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
    // 合成（synth）とアセット配置を分離する。dist が無い状態でも synth/テストが通るよう、
    // 成果物が存在するときだけ BucketDeployment を作成し、無ければ警告注釈を出すだけにする。
    if (existsSync(path.join(distDir, 'index.html'))) {
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
    } else {
      // dist が無くても synth/テストは通す（意図的にスキップ）。ただしこのまま
      // cdk deploy すると SPA バケットが空のまま公開されるため、強めに警告する。
      // 通常はルートの cdk:deploy が web:build を先に走らせるので発生しない。
      Annotations.of(this).addWarning(
        'web の dist が見つかりません。SPA アセットのデプロイをスキップします。' +
          'このまま cdk deploy すると空のサイトが配信されます。' +
          'cdk deploy 前に pnpm --filter web build（またはルートの pnpm cdk:deploy）を実行してください。',
      );
    }
  }
}

/**
 * tenant-config.js に焼き込む tenant→設定マップの JS オブジェクトリテラル文字列を作る。
 *
 * userPoolId / userPoolClientId は CloudFormation トークン（cross-stack 参照）のため
 * JSON.stringify では解決できない（`${Token[...]}` という文字列になる）。そこで
 * トークンはテンプレートリテラルで連結し（CDK が Fn::Join 化してデプロイ時に解決）、
 * トークンでない値（tenantId / hostedUiDomain）だけ JSON.stringify で安全にエスケープする。
 *
 * 生成例（トークンは実際には解決される）:
 *   {"tenant-a":{"userPoolId":"<token>","userPoolClientId":"<token>","hostedUiDomain":"x.auth..."}}
 */
function buildTenantMapLiteral(
  tenants: readonly EdgeTenantPublicConfig[],
  hostedUiDomain: string,
): string {
  const domainLiteral = JSON.stringify(hostedUiDomain);
  const entries = tenants.map((t) => {
    const key = JSON.stringify(t.tenantId);
    // userPoolId / userPoolClientId はトークン。テンプレートリテラルで連結すると
    // CDK トークンとして扱われ、最終的に Fn::Join に展開される。JSON 文字列値に
    // するため前後をダブルクオートで囲む。トークンは英数字とアンダースコアのみで
    // 構成される Cognito のID/ARNの一部であり、JSON のエスケープは不要。
    const poolId = `"${t.userPoolId}"`;
    const clientId = `"${t.userPoolClientId}"`;
    return `${key}:{"userPoolId":${poolId},"userPoolClientId":${clientId},"hostedUiDomain":${domainLiteral}}`;
  });
  return `{${entries.join(',')}}`;
}
