import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BackendApiStack } from '../lib/backend-api-stack';
import type { BackendApiConfig } from '../lib/config';

const config: BackendApiConfig = {
  baseDomain: 'example.com',
  certificateArn:
    'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
  hostedZoneId: 'Z0000000000000000000',
  initialTenants: ['app'],
  allowedOrigins: ['https://app.example.com', 'http://localhost:5173'],
  authDomainPrefix: 'test-multitenant-boilerplate',
};

function synth() {
  const app = new cdk.App();
  const stack = new BackendApiStack(app, 'TestStack', {
    config,
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
}

describe('BackendApiStack', () => {
  test('主要リソースが合成される', () => {
    const template = synth();

    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::DistributionTenant', 1);
    template.resourceCountIs('AWS::CloudFront::ConnectionGroup', 1);
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    // SPA 配信用 S3 バケットと OAC。バケットは web アセット用と
    // BucketDeployment のデプロイ作業用の2つ（後者は CDK 内部が作る）。
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    // テストは web/dist 無しで synth するため BucketDeployment は作られない（0 件）。
    // dist が存在する場合のみアセット用 + index.html 用の2つが作られる。
    template.resourceCountIs('Custom::CDKBucketDeployment', 0);
    // CloudFront Function は tenant-resolver と spa-router の2つ。
    template.resourceCountIs('AWS::CloudFront::Function', 2);
  });

  test('SPA(S3) がデフォルト、/api/* が API Gateway に振り分けられる', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
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
    const template = synth();

    // spa-router Function の論理 ID を FunctionCode の内容から特定する。
    // （tenant-resolver ではなく spa-router が default behavior に付いていることを厳密に検証する）
    const fns = template.findResources('AWS::CloudFront::Function');
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
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
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
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.absent(),
      },
    });
  });

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

  test('REST API が REQUEST 型 Authorizer を持つ', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'REQUEST',
    });
  });

  test('CORS プリフライト(OPTIONS)が Authorizer なしで追加される', () => {
    const template = synth();
    // OPTIONS は MOCK 統合・authorizationType NONE で返す。
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'OPTIONS',
      AuthorizationType: 'NONE',
      Integration: { Type: 'MOCK' },
    });
  });

  test('Hosted UI（User Pool Domain と OAuth 設定）が作られる', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'test-multitenant-boilerplate',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: ['https://app.example.com', 'http://localhost:5173'],
    });
  });

  test('マルチテナントディストリビューションである', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        ConnectionMode: 'tenant-only',
      },
    });
  });

  test('CloudFront Function に config.baseDomain が注入されプレースホルダが残らない', () => {
    const app = new cdk.App();
    const stack = new BackendApiStack(app, 'CustomDomainStack', {
      config: { ...config, baseDomain: 'example.com' },
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    const template = Template.fromStack(stack);

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
});
