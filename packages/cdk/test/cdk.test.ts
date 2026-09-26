import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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
