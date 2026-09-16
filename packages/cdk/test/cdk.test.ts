import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BackendApiStack } from '../lib/backend-api-stack';
import type { BackendApiConfig } from '../lib/config';

const config: BackendApiConfig = {
  baseDomain: 'chelky.click',
  certificateArn:
    'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
  hostedZoneId: 'Z0000000000000000000',
  initialTenants: ['app'],
  enableTenantIsolation: false,
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

  test('マルチテナントディストリビューションである', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        ConnectionMode: 'tenant-only',
      },
    });
  });
});
