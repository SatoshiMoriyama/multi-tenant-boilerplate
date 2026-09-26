import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BackendStack } from '../lib/backend-stack';
import type { BackendApiConfig } from '../lib/config';
import { FrontendStack } from '../lib/frontend-stack';

const config: BackendApiConfig = {
  baseDomain: 'example.com',
  certificateArn:
    'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
  hostedZoneId: 'Z0000000000000000000',
  initialTenants: ['app'],
  allowedOrigins: ['https://app.example.com', 'http://localhost:5173'],
  authDomainPrefix: 'test-multitenant-boilerplate',
};

const env = { account: '123456789012', region: 'ap-northeast-1' };

/**
 * バックエンド / フロントエンドの2スタックを同一 app 内で合成し、それぞれの
 * テンプレートを返す。FrontendStack は BackendStack の restApi / originVerifySecret を
 * props（cross-stack 参照）で受け取る。
 */
function synth() {
  const app = new cdk.App();
  const backend = new BackendStack(app, 'TestBackend', { config, env });
  const frontend = new FrontendStack(app, 'TestFrontend', {
    config,
    restApi: backend.restApi,
    originVerifySecret: backend.originVerifySecret,
    env,
  });
  return {
    backendTemplate: Template.fromStack(backend),
    frontendTemplate: Template.fromStack(frontend),
  };
}

describe('BackendStack', () => {
  test('主要リソース（認証 / API / シークレット）が合成される', () => {
    const { backendTemplate } = synth();

    backendTemplate.resourceCountIs('AWS::Cognito::UserPool', 1);
    backendTemplate.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    backendTemplate.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  test('REST API が REQUEST 型 Authorizer を持つ', () => {
    const { backendTemplate } = synth();
    backendTemplate.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'REQUEST',
    });
  });

  test('CORS プリフライト(OPTIONS)が Authorizer なしで追加される', () => {
    const { backendTemplate } = synth();
    // OPTIONS は MOCK 統合・authorizationType NONE で返す。
    backendTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'OPTIONS',
      AuthorizationType: 'NONE',
      Integration: { Type: 'MOCK' },
    });
  });

  test('Hosted UI（User Pool Domain と OAuth 設定）が作られる', () => {
    const { backendTemplate } = synth();
    backendTemplate.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'test-multitenant-boilerplate',
    });
    backendTemplate.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: ['https://app.example.com', 'http://localhost:5173'],
    });
  });
});

describe('FrontendStack', () => {
  test('主要リソース（CloudFront / テナント / OAC / Function）が合成される', () => {
    const { frontendTemplate } = synth();

    frontendTemplate.resourceCountIs('AWS::CloudFront::Distribution', 1);
    frontendTemplate.resourceCountIs('AWS::CloudFront::DistributionTenant', 1);
    frontendTemplate.resourceCountIs('AWS::CloudFront::ConnectionGroup', 1);
    // SPA 配信用 S3 バケットと OAC。
    frontendTemplate.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    // テストは web/dist 無しで synth するため BucketDeployment は作られない（0 件）。
    // dist が存在する場合のみアセット用 + index.html 用の2つが作られる。
    frontendTemplate.resourceCountIs('Custom::CDKBucketDeployment', 0);
    // CloudFront Function は tenant-resolver と spa-router の2つ。
    frontendTemplate.resourceCountIs('AWS::CloudFront::Function', 2);
  });

  test('マルチテナントディストリビューションである', () => {
    const { frontendTemplate } = synth();
    frontendTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        ConnectionMode: 'tenant-only',
      },
    });
  });

  test('SPA(S3) がデフォルト、/api/* が API Gateway に振り分けられる', () => {
    const { frontendTemplate } = synth();
    frontendTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        CacheBehaviors: [
          {
            PathPattern: '/api/*',
          },
        ],
      },
    });
  });

  test('SPA フォールバックが default behavior の spa-router(viewer-request) で行われ、CustomErrorResponses は使われない', () => {
    const { frontendTemplate } = synth();

    // spa-router Function の論理 ID を FunctionCode の内容から特定する。
    // （tenant-resolver ではなく spa-router が default behavior に付いていることを厳密に検証する）
    const fns = frontendTemplate.findResources('AWS::CloudFront::Function');
    const isSpaRouterCode = (code: unknown) =>
      typeof code === 'string' &&
      code.includes("request.uri = '/index.html'");
    const spaRouterLogicalIds = Object.entries(fns)
      .filter(([, r]) => isSpaRouterCode(r.Properties?.FunctionCode))
      .map(([logicalId]) => logicalId);
    expect(spaRouterLogicalIds).toHaveLength(1);
    const spaRouterLogicalId = spaRouterLogicalIds[0];

    // tenant-resolver は別 Function であることも確認（取り違え防止）。
    const tenantResolverIds = Object.entries(fns)
      .filter(([, r]) => !isSpaRouterCode(r.Properties?.FunctionCode))
      .map(([logicalId]) => logicalId);
    expect(tenantResolverIds).toHaveLength(1);

    // default behavior の viewer-request FunctionAssociation が spa-router を指すことを検証する。
    // L1 CfnDistribution では functionArn は Function の Arn を Fn::GetAtt で参照する。
    frontendTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          FunctionAssociations: Match.arrayWith([
            {
              EventType: 'viewer-request',
              FunctionARN: {
                'Fn::GetAtt': [spaRouterLogicalId, 'FunctionARN'],
              },
            },
          ]),
        },
      },
    });

    // ディストリビューション全体に効く CustomErrorResponses は定義しない。
    frontendTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.absent(),
      },
    });
  });

  test('CloudFront Function に config.baseDomain が注入されプレースホルダが残らない', () => {
    const app = new cdk.App();
    const backend = new BackendStack(app, 'CustomDomainBackend', {
      config: { ...config, baseDomain: 'example.com' },
      env,
    });
    const frontend = new FrontendStack(app, 'CustomDomainFrontend', {
      config: { ...config, baseDomain: 'example.com' },
      restApi: backend.restApi,
      originVerifySecret: backend.originVerifySecret,
      env,
    });
    const template = Template.fromStack(frontend);

    const fns = template.findResources('AWS::CloudFront::Function');
    const codes = Object.values(fns).map(
      (r) => r.Properties.FunctionCode as string,
    );
    // config.baseDomain が焼き込まれ、未置換プレースホルダが残らない。
    expect(
      codes.some((c) => c.includes("var baseDomain = 'example.com'")),
    ).toBe(true);
    expect(codes.some((c) => c.includes('__BASE_DOMAIN__'))).toBe(false);
  });

  test('FrontendStack が BackendStack をスタック間参照する', () => {
    const { backendTemplate, frontendTemplate } = synth();

    // (a) オリジン検証シークレットはバックエンドスタックにのみ存在し、
    // フロントエンドスタックには複製されない（参照のみ）。
    backendTemplate.resourceCountIs('AWS::SecretsManager::Secret', 1);
    frontendTemplate.resourceCountIs('AWS::SecretsManager::Secret', 0);

    // (b) CloudFront ディストリビューションの API オリジンのドメイン名と
    // X-Origin-Verify ヘッダー値が、フロントエンドスタック内で合成された素の
    // 文字列リテラルではなく、スタック間参照（Fn::ImportValue を含むトークン）や
    // secretsmanager の動的参照であることを検証する。
    const distributions = frontendTemplate.findResources(
      'AWS::CloudFront::Distribution',
    );
    const distributionKeys = Object.keys(distributions);
    expect(distributionKeys).toHaveLength(1);
    const distribution = distributions[distributionKeys[0]];

    const origins = distribution.Properties?.DistributionConfig
      ?.Origins as Array<{
      Id: string;
      DomainName: unknown;
      OriginCustomHeaders?: Array<{ HeaderName: string; HeaderValue: unknown }>;
    }>;
    const apiOrigin = origins.find((o) => o.Id === 'ApiOrigin');
    expect(apiOrigin).toBeDefined();

    // API オリジンのドメイン名は restApiId（バックエンド側リソース）を含むため、
    // リテラル文字列ではなく Fn::Join でスタック間 import を組み立てたトークンになる。
    expect(typeof apiOrigin?.DomainName).toBe('object');
    expect(JSON.stringify(apiOrigin?.DomainName)).toContain('Fn::ImportValue');

    // X-Origin-Verify ヘッダー値は originVerifySecret の動的参照。バックエンドの
    // シークレット ARN をスタック間 import して解決するため、これもリテラルではなく
    // Fn::ImportValue を含むトークンになる。
    const originVerify = apiOrigin?.OriginCustomHeaders?.find(
      (h) => h.HeaderName === 'X-Origin-Verify',
    );
    expect(originVerify).toBeDefined();
    expect(typeof originVerify?.HeaderValue).toBe('object');
    expect(JSON.stringify(originVerify?.HeaderValue)).toContain(
      'Fn::ImportValue',
    );
  });
});

describe('spa-router.js', () => {
  test('spa-router.js の書き換えロジック（ユニット）', () => {
    // 注意: このテストは spa-router.js を直接 require して handler を実行する。
    // CloudFront Function は素の JS（var / function handler）なので Node で評価できる。
    // （INTEGRATIONS_ONLY のサンドボックスでは jest 自体は実行できないが、構成上は正しい）
    const fnPath = path.join(
      __dirname,
      '..',
      'lib',
      'functions',
      'spa-router.js',
    );
    const src = readFileSync(fnPath, 'utf-8');
    // biome-ignore lint/security/noGlobalEval: CloudFront Function を評価してユニットテストするための限定的な利用。
    const handler = new Function(`${src}; return handler;`)() as (e: {
      request: { uri: string };
    }) => { uri: string };
    const run = (uri: string) => handler({ request: { uri } }).uri;

    // ディープリンク（拡張子なし）は SPA エントリへ。
    expect(run('/dashboard')).toBe('/index.html');
    expect(run('/settings/profile')).toBe('/index.html');
    expect(run('/')).toBe('/index.html');
    // ドットを含む拡張子なしのクライアントルートも書き換える（Issue 1 の修正点）。
    expect(run('/reports/2024.q1')).toBe('/index.html');
    expect(run('/v1.2/overview')).toBe('/index.html');
    // 既知拡張子の静的アセットはそのまま。
    expect(run('/assets/app.abcd.js')).toBe('/assets/app.abcd.js');
    expect(run('/favicon.ico')).toBe('/favicon.ico');
    expect(run('/fonts/inter.woff2')).toBe('/fonts/inter.woff2');
    // /api/* は多層防御として素通し。
    expect(run('/api/me')).toBe('/api/me');
    expect(run('/api/tenants/123')).toBe('/api/tenants/123');
  });
});
