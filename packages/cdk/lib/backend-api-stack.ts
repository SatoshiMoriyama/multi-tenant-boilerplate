import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib/core';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { BackendApiConfig } from './config';
import { Api } from './constructs/api';
import { Auth } from './constructs/auth';
import { TenantAuthorizer } from './constructs/authorizer';
import { Edge } from './constructs/edge';
import { Tenants } from './constructs/tenants';

export interface BackendApiStackProps extends StackProps {
  readonly config: BackendApiConfig;
}

export class BackendApiStack extends Stack {
  constructor(scope: Construct, id: string, props: BackendApiStackProps) {
    super(scope, id, props);

    const { config } = props;

    // CloudFront → API Gateway のオリジン検証シークレット。
    const originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: 'Shared secret to verify requests originate from CloudFront',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const auth = new Auth(this, 'Auth');

    const authorizer = new TenantAuthorizer(this, 'Authorizer', {
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      originVerifySecret,
    });

    const api = new Api(this, 'Api', {
      authorizer: authorizer.authorizer,
      enableTenantIsolation: config.enableTenantIsolation,
    });

    const edge = new Edge(this, 'Edge', {
      restApi: api.restApi,
      baseDomain: config.baseDomain,
      certificateArn: config.certificateArn,
      originVerifySecret,
    });

    new Tenants(this, 'Tenants', {
      distributionId: edge.distributionId,
      baseDomain: config.baseDomain,
      initialTenants: config.initialTenants,
      hostedZoneId: config.hostedZoneId,
    });

    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', {
      value: auth.userPoolClient.userPoolClientId,
    });
    new CfnOutput(this, 'RestApiId', { value: api.restApi.restApiId });
    new CfnOutput(this, 'DistributionId', { value: edge.distributionId });
  }
}
