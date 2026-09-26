import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import type { BackendApiConfig } from './config';
import { Edge } from './constructs/edge';
import { Tenants } from './constructs/tenants';

export interface FrontendStackProps extends StackProps {
  readonly config: BackendApiConfig;
  /** バックエンドスタックが公開する REST API（CloudFront オリジン） */
  readonly restApi: apigateway.RestApi;
  /** バックエンドスタックが作成したオリジン検証シークレット */
  readonly originVerifySecret: secretsmanager.ISecret;
}

/**
 * フロントエンド配信スタック。
 * CloudFront マルチテナントディストリビューション + S3(SPA 配信) + BucketDeployment(Edge) と、
 * distribution tenant / DNS(Tenants) を持つ。
 * restApi と originVerifySecret はバックエンドスタックから props（同一 app 内の
 * cross-stack 参照）で受け取る。originVerifySecret は secretsmanager の動的参照の
 * ままオリジンカスタムヘッダーに埋め込まれ、平文はエクスポートされない。
 */
export class FrontendStack extends Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { config } = props;

    const edge = new Edge(this, 'Edge', {
      restApi: props.restApi,
      baseDomain: config.baseDomain,
      certificateArn: config.certificateArn,
      originVerifySecret: props.originVerifySecret,
    });

    new Tenants(this, 'Tenants', {
      distributionId: edge.distributionId,
      baseDomain: config.baseDomain,
      initialTenants: config.initialTenants,
      hostedZoneId: config.hostedZoneId,
    });

    new CfnOutput(this, 'DistributionId', { value: edge.distributionId });
    new CfnOutput(this, 'SiteBucketName', {
      value: edge.siteBucket.bucketName,
    });
  }
}
