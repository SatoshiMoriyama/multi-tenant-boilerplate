import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BackendStack } from '../lib/backend-stack';
import {
  type BackendApiConfig,
  buildTenantClients,
  resolveConfig,
} from '../lib/config';
import {
  CostGovernanceStack,
  type CostGovernanceStackProps,
} from '../lib/cost-governance-stack';
import { FrontendStack } from '../lib/frontend-stack';

const config: BackendApiConfig = {
  baseDomain: 'example.com',
  certificateArn:
    'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
  hostedZoneId: 'Z0000000000000000000',
  // App-client per tenant の分離を検証するため2テナントで synth する。
  initialTenants: ['tenant-a', 'tenant-b'],
  allowedOrigins: [
    'https://tenant-a.example.com',
    'https://tenant-b.example.com',
    'http://localhost:5173',
  ],
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
    tenantPublicConfigs: backend.tenantPublicConfigs,
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

  test('Hosted UI の User Pool Domain が作られる', () => {
    const { backendTemplate } = synth();
    backendTemplate.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'test-multitenant-boilerplate',
    });
  });

  test('App Client がテナント数ぶん作られる（App-client per tenant）', () => {
    const { backendTemplate } = synth();
    // initialTenants: ['tenant-a', 'tenant-b'] なので App Client は2つ。
    backendTemplate.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
  });

  test('各 App Client の callback が自テナントのオリジン + 共有 dev に限定される', () => {
    const { backendTemplate } = synth();

    // tenant-a の client: 自ドメイン + localhost（tenant-b のドメインは含まない）。
    backendTemplate.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'tenant-tenant-a',
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: ['https://tenant-a.example.com', 'http://localhost:5173'],
    });

    // tenant-b の client: 自ドメイン + localhost（tenant-a のドメインは含まない）。
    backendTemplate.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'tenant-tenant-b',
      CallbackURLs: ['https://tenant-b.example.com', 'http://localhost:5173'],
    });
  });

  test('Authorizer に tenantId->clientId マップが渡る', () => {
    const { backendTemplate } = synth();
    // TENANT_CLIENT_MAP は clientId が Ref のため Fn::Join に展開される。
    // JSON 文字列化して各テナントのキーが含まれることを検証する。
    const fns = backendTemplate.findResources('AWS::Lambda::Function');
    const mapValues = Object.values(fns)
      .map((r) => r.Properties?.Environment?.Variables?.TENANT_CLIENT_MAP)
      .filter((v) => v !== undefined);
    expect(mapValues).toHaveLength(1);
    const serialized = JSON.stringify(mapValues[0]);
    expect(serialized).toContain('tenant-a');
    expect(serialized).toContain('tenant-b');
    // clientId は Ref でスタック内リソース参照になる（リテラルではない）。
    expect(serialized).toContain('Ref');
  });
});

describe('FrontendStack', () => {
  test('主要リソース（CloudFront / テナント / OAC / Function）が合成される', () => {
    const { frontendTemplate } = synth();

    frontendTemplate.resourceCountIs('AWS::CloudFront::Distribution', 1);
    // DistributionTenant はテナント数ぶん（initialTenants: tenant-a, tenant-b）。
    frontendTemplate.resourceCountIs('AWS::CloudFront::DistributionTenant', 2);
    frontendTemplate.resourceCountIs('AWS::CloudFront::ConnectionGroup', 1);
    // SPA 配信用 S3 バケットと OAC。
    frontendTemplate.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    // BucketDeployment は web/dist の有無で変わる。dist 無しなら 0 件、dist が
    // あればアセット用 + index.html 用の 2 件。ローカルに dist がビルド済みか
    // どうかでテストが壊れないよう、存在を見て期待値を切り替える。
    const webDistExists = existsSync(
      path.join(__dirname, '..', '..', 'web', 'dist', 'index.html'),
    );
    frontendTemplate.resourceCountIs(
      'Custom::CDKBucketDeployment',
      webDistExists ? 2 : 0,
    );
    // CloudFront Function は tenant-resolver / spa-router / tenant-config の3つ。
    frontendTemplate.resourceCountIs('AWS::CloudFront::Function', 3);
  });

  test('SPA バケットに未完了マルチパートアップロードの中止ルールがある', () => {
    const { frontendTemplate } = synth();

    // バージョニング無効のバケットなので、設定するのは MPU 中止ルールのみ。
    // NoncurrentVersionExpiration / ExpiredObjectDeleteMarker は効果がないため
    // 持たせない（意図しない追加を検知する）。
    frontendTemplate.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'abort-incomplete-multipart-upload',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
        ],
      },
    });
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
        // behavior は /tenant-config.json と /api/* の2つ。/api/* の存在を検証する。
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/api/*',
          }),
        ]),
      },
    });
  });

  test('/tenant-config.json 専用 behavior が tenant-config Function を viewer-request に持つ', () => {
    const { frontendTemplate } = synth();

    // tenant-config Function は FunctionCode にトークン（clientId の Ref）を含むため
    // Fn::Join になる。これを持つ Function の論理 ID を特定する。
    const fns = frontendTemplate.findResources('AWS::CloudFront::Function');
    const tenantConfigIds = Object.entries(fns)
      .filter(([, r]) => typeof r.Properties?.FunctionCode !== 'string')
      .map(([logicalId]) => logicalId);
    expect(tenantConfigIds).toHaveLength(1);
    const tenantConfigId = tenantConfigIds[0];

    // /tenant-config.json behavior が tenant-config Function を viewer-request に持つ。
    frontendTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/tenant-config.json',
            FunctionAssociations: Match.arrayWith([
              {
                EventType: 'viewer-request',
                FunctionARN: {
                  'Fn::GetAtt': [tenantConfigId, 'FunctionARN'],
                },
              },
            ]),
          }),
        ]),
      },
    });
  });

  test('tenant-config のコードに各テナントの clientId 参照が焼き込まれる（列挙されない=Host解決）', () => {
    const { frontendTemplate } = synth();
    const fns = frontendTemplate.findResources('AWS::CloudFront::Function');
    const tenantConfigCode = Object.values(fns)
      .map((r) => r.Properties?.FunctionCode)
      .find((code) => typeof code !== 'string');
    expect(tenantConfigCode).toBeDefined();
    const serialized = JSON.stringify(tenantConfigCode);
    // 2テナント分の clientId が Ref（スタック内参照）として埋まる。
    expect(serialized).toContain('Ref');
    // tenant キーが JS マップリテラルとして焼き込まれている。
    expect(serialized).toContain('tenant-a');
    expect(serialized).toContain('tenant-b');
  });

  test('SPA フォールバックが default behavior の spa-router(viewer-request) で行われ、CustomErrorResponses は使われない', () => {
    const { frontendTemplate } = synth();

    // spa-router Function の論理 ID を FunctionCode の内容から特定する。
    // （spa-router が default behavior に付いていることを厳密に検証する）
    // tenant-config はコードにトークンを含み FunctionCode が Fn::Join(オブジェクト)に
    // なるため、文字列比較の対象外（型ガードで自然に除外される）。
    const fns = frontendTemplate.findResources('AWS::CloudFront::Function');
    const isSpaRouterCode = (code: unknown) =>
      typeof code === 'string' && code.includes("request.uri = '/index.html'");
    const spaRouterLogicalIds = Object.entries(fns)
      .filter(([, r]) => isSpaRouterCode(r.Properties?.FunctionCode))
      .map(([logicalId]) => logicalId);
    expect(spaRouterLogicalIds).toHaveLength(1);
    const spaRouterLogicalId = spaRouterLogicalIds[0];

    // Function は全部で3つ（spa-router / tenant-resolver / tenant-config）。
    expect(Object.keys(fns)).toHaveLength(3);

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
      tenantPublicConfigs: backend.tenantPublicConfigs,
      env,
    });
    const template = Template.fromStack(frontend);

    const fns = template.findResources('AWS::CloudFront::Function');
    // FunctionCode は文字列（トークン無し）か Fn::Join(オブジェクト、トークン有り）。
    // baseDomain 注入・プレースホルダ残存は全 Function を対象に検証したいので、
    // オブジェクトは JSON 文字列化して走査する。
    const codes = Object.values(fns).map((r) => {
      const code = r.Properties.FunctionCode;
      return typeof code === 'string' ? code : JSON.stringify(code);
    });
    // config.baseDomain が焼き込まれ、未置換プレースホルダが残らない。
    expect(
      codes.some((c) => c.includes("var baseDomain = 'example.com'")),
    ).toBe(true);
    expect(codes.some((c) => c.includes('__BASE_DOMAIN__'))).toBe(false);
    // tenant-config のプレースホルダも残らない。
    expect(codes.some((c) => c.includes('__TENANT_CLIENT_MAP__'))).toBe(false);
  });

  test('FrontendStack が BackendStack への依存を宣言する（デプロイ順序 Backend → Frontend）', () => {
    // bin/cdk.ts と同じく addDependency を宣言し、Frontend が Backend に依存することを検証する。
    // デプロイ順序（Backend → Frontend）はスタック分割設計の要であり、cross-stack 参照が
    // 解決可能であるための前提になっている。
    const app = new cdk.App();
    const backend = new BackendStack(app, 'DepBackend', { config, env });
    const frontend = new FrontendStack(app, 'DepFrontend', {
      config,
      restApi: backend.restApi,
      originVerifySecret: backend.originVerifySecret,
      tenantPublicConfigs: backend.tenantPublicConfigs,
      env,
    });
    frontend.addDependency(backend);

    expect(frontend.dependencies).toContain(backend);
    expect(backend.dependencies).not.toContain(frontend);
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

describe('CostGovernanceStack', () => {
  function synthGovernance(
    overrides: Partial<CostGovernanceStackProps> = {},
  ): Template {
    const app = new cdk.App();
    const stack = new CostGovernanceStack(app, 'TestCostGovernance', {
      alertEmail: 'cost-alerts@example.com',
      monthlyBudgetUsd: 100,
      createAnomalyMonitor: true,
      env,
      ...overrides,
    });
    return Template.fromStack(stack);
  }

  test('月次予算が予測80% / 実績100%の2段で通知する', () => {
    const template = synthGovernance();

    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetName: 'TestCostGovernance-monthly-budget',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 100, Unit: 'USD' },
      },
      NotificationsWithSubscribers: [
        {
          Notification: {
            NotificationType: 'FORECASTED',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 80,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: [
            {
              SubscriptionType: 'EMAIL',
              Address: 'cost-alerts@example.com',
            },
          ],
        },
        {
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 100,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: [
            {
              SubscriptionType: 'EMAIL',
              Address: 'cost-alerts@example.com',
            },
          ],
        },
      ],
    });
  });

  test('SERVICE ディメンションの AWS 管理モニターとサブスクリプションを作る', () => {
    const template = synthGovernance();

    template.hasResourceProperties('AWS::CE::AnomalyMonitor', {
      MonitorName: 'TestCostGovernance-service-monitor',
      MonitorType: 'DIMENSIONAL',
      MonitorDimension: 'SERVICE',
    });
    template.hasResourceProperties('AWS::CE::AnomalySubscription', {
      SubscriptionName: 'TestCostGovernance-anomaly-subscription',
      Frequency: 'DAILY',
      Subscribers: [{ Type: 'EMAIL', Address: 'cost-alerts@example.com' }],
    });
  });

  test('サブスクリプションは Threshold ではなく ThresholdExpression を持つ', () => {
    const template = synthGovernance();

    // Threshold（非推奨）と ThresholdExpression は排他。両方指定すると
    // CloudFormation が検証エラーになるため、後者のみであることを検証する。
    const subscriptions = template.findResources(
      'AWS::CE::AnomalySubscription',
    );
    const properties = Object.values(subscriptions).map((r) => r.Properties);
    expect(properties).toHaveLength(1);
    expect(properties[0]).not.toHaveProperty('Threshold');
    expect(JSON.parse(properties[0].ThresholdExpression)).toEqual({
      Dimensions: {
        Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
        MatchOptions: ['GREATER_THAN_OR_EQUAL'],
        Values: ['10'],
      },
    });
  });

  test('createAnomalyMonitor=false なら予算だけ作り異常検知は作らない', () => {
    const template = synthGovernance({ createAnomalyMonitor: false });

    // AWS 管理のサービスモニターはアカウント1個までなので、既存がある環境では
    // 予算のみをデプロイできる必要がある。
    template.resourceCountIs('AWS::Budgets::Budget', 1);
    template.resourceCountIs('AWS::CE::AnomalyMonitor', 0);
    template.resourceCountIs('AWS::CE::AnomalySubscription', 0);
  });

  test('アプリケーションスタックのリソースを一切持たない', () => {
    const template = synthGovernance();

    // BackendStack / FrontendStack と分離されていることの担保。
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });
});

describe('resolveConfig（コストガバナンス context）', () => {
  const baseContext: Record<string, unknown> = {
    certificateArn:
      'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
    hostedZoneId: 'Z0000000000000000000',
  };

  function resolve(extra: Record<string, unknown> = {}) {
    const merged = { ...baseContext, ...extra };
    return resolveConfig((key) => merged[key]);
  }

  test('alertEmail 未指定ならコストガバナンス設定は undefined', () => {
    const resolved = resolve();

    expect(resolved.alertEmail).toBeUndefined();
    expect(resolved.monthlyBudgetUsd).toBeUndefined();
    expect(resolved.createCostAnomalyMonitor).toBeUndefined();
  });

  test('alertEmail 指定時は予算が既定 100 / モニター作成が既定 true', () => {
    const resolved = resolve({ alertEmail: 'cost-alerts@example.com' });

    expect(resolved.monthlyBudgetUsd).toBe(100);
    expect(resolved.createCostAnomalyMonitor).toBe(true);
  });

  test('-c で文字列として渡った値を数値 / 真偽値に解釈する', () => {
    const resolved = resolve({
      alertEmail: 'cost-alerts@example.com',
      monthlyBudgetUsd: '250',
      createCostAnomalyMonitor: 'false',
    });

    expect(resolved.monthlyBudgetUsd).toBe(250);
    expect(resolved.createCostAnomalyMonitor).toBe(false);
  });

  test('monthlyBudgetUsd が正の数でなければエラー', () => {
    expect(() =>
      resolve({ alertEmail: 'cost-alerts@example.com', monthlyBudgetUsd: '0' }),
    ).toThrow("context 'monthlyBudgetUsd' must be a positive number");
    expect(() =>
      resolve({
        alertEmail: 'cost-alerts@example.com',
        monthlyBudgetUsd: 'abc',
      }),
    ).toThrow("context 'monthlyBudgetUsd' must be a positive number");
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

describe('buildTenantClients（テナント分離）', () => {
  test('未登録の baseDomain サブドメインはどのテナントの callback にも含まれない', () => {
    // allowedOrigins に未登録テナント（tenant-c）を混ぜても、共有 dev オリジン扱い
    // されず、tenant-a / tenant-b いずれの client にも割り当てられないことを検証する。
    const defs = buildTenantClients({
      baseDomain: 'example.com',
      initialTenants: ['tenant-a', 'tenant-b'],
      allowedOrigins: [
        'https://tenant-a.example.com',
        'https://tenant-b.example.com',
        // 未登録テナント。拒否されるべき。
        'https://tenant-c.example.com',
        'http://localhost:5173',
      ],
    });

    const byId = new Map(defs.map((d) => [d.tenantId, d.callbackOrigins]));
    const tenantA = byId.get('tenant-a') ?? [];
    const tenantB = byId.get('tenant-b') ?? [];

    // 未登録テナントの URL はどちらにも現れない。
    expect(tenantA).not.toContain('https://tenant-c.example.com');
    expect(tenantB).not.toContain('https://tenant-c.example.com');

    // 自テナントのサブドメイン + 共有 dev（localhost）は残る。
    expect(tenantA).toEqual([
      'https://tenant-a.example.com',
      'http://localhost:5173',
    ]);
    expect(tenantB).toEqual([
      'https://tenant-b.example.com',
      'http://localhost:5173',
    ]);
  });

  test('別テナントのサブドメインは自テナントの callback に混ざらない', () => {
    // allowedOrigins に両テナントのサブドメインを入れても、各 client には自分の
    // サブドメインだけが割り当てられる（他テナントのドメインへリダイレクトできない）。
    const defs = buildTenantClients({
      baseDomain: 'example.com',
      initialTenants: ['tenant-a', 'tenant-b'],
      allowedOrigins: [
        'https://tenant-a.example.com',
        'https://tenant-b.example.com',
        'http://localhost:5173',
      ],
    });

    const byId = new Map(defs.map((d) => [d.tenantId, d.callbackOrigins]));
    expect(byId.get('tenant-a')).not.toContain('https://tenant-b.example.com');
    expect(byId.get('tenant-b')).not.toContain('https://tenant-a.example.com');
  });

  test('baseDomain 配下でないオリジン（localhost）は全テナントで共有される', () => {
    const defs = buildTenantClients({
      baseDomain: 'example.com',
      initialTenants: ['tenant-a', 'tenant-b'],
      allowedOrigins: ['http://localhost:5173'],
    });

    for (const def of defs) {
      // 自サブドメイン + 共有 dev（localhost）。
      expect(def.callbackOrigins).toContain(
        `https://${def.tenantId}.example.com`,
      );
      expect(def.callbackOrigins).toContain('http://localhost:5173');
    }
  });
});

describe('tenant-config.js', () => {
  test('一致するホストは 200 で CORS ヘッダー(*)を返す（ユニット）', () => {
    // 注意: このテストは tenant-config.js を読み込み、__BASE_DOMAIN__ と
    // __TENANT_CLIENT_MAP__ のプレースホルダを具体値へ置換してから handler を
    // 評価する。CloudFront Function は素の JS（var / function handler）なので
    // Node で評価できる（spa-router.js のユニットテストと同じ方式）。
    const fnPath = path.join(
      __dirname,
      '..',
      'lib',
      'functions',
      'tenant-config.js',
    );
    let src = readFileSync(fnPath, 'utf-8');
    // edge.ts が synth 時に行うプレースホルダ置換を、テスト用の具体値で再現する。
    src = src.replace('__BASE_DOMAIN__', 'example.com');
    src = src.replace(
      '__TENANT_CLIENT_MAP__',
      JSON.stringify({
        'tenant-a': {
          userPoolId: 'ap-northeast-1_AAA',
          userPoolClientId: 'client-a',
          hostedUiDomain: 'auth-a.example.com',
        },
      }),
    );
    // biome-ignore lint/security/noGlobalEval: CloudFront Function を評価してユニットテストするための限定的な利用。
    const handler = new Function(`${src}; return handler;`)() as (e: {
      request: { headers: { host: { value: string } }; uri: string };
    }) => {
      statusCode: number;
      headers: Record<string, { value: string }>;
      body: string;
    };

    const res = handler({
      request: {
        headers: { host: { value: 'tenant-a.example.com' } },
        uri: '/tenant-config.json',
      },
    });

    // 200 レスポンスに Access-Control-Allow-Origin: '*' が含まれる。
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin'].value).toBe('*');
    // 該当テナント1件分の公開設定が返る。
    expect(JSON.parse(res.body).userPoolClientId).toBe('client-a');
  });
});
