import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface TenantsProps {
  /** 親マルチテナントディストリビューションID */
  readonly distributionId: string;
  readonly baseDomain: string;
  /** フェーズ1で用意する pooled テナントのサブドメイン一覧 */
  readonly initialTenants: readonly string[];
  readonly hostedZoneId: string;
}

/**
 * connection group（1つ、共有）と distribution tenant（テナント別）を作成し、
 * 各テナントの {tenant}.baseDomain CNAME を connection group の
 * routing endpoint に向ける。
 */
export class Tenants extends Construct {
  readonly connectionGroup: cloudfront.CfnConnectionGroup;

  constructor(scope: Construct, id: string, props: TenantsProps) {
    super(scope, id);

    this.connectionGroup = new cloudfront.CfnConnectionGroup(this, 'ConnectionGroup', {
      name: 'default-connection-group',
      enabled: true,
      ipv6Enabled: true,
    });

    const routingEndpoint = this.connectionGroup.attrRoutingEndpoint;

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.baseDomain,
    });

    for (const tenant of props.initialTenants) {
      const domain = `${tenant}.${props.baseDomain}`;

      const distributionTenant = new cloudfront.CfnDistributionTenant(
        this,
        `Tenant-${tenant}`,
        {
          distributionId: props.distributionId,
          connectionGroupId: this.connectionGroup.attrId,
          name: `tenant-${tenant}`,
          domains: [domain],
          enabled: true,
        },
      );
      distributionTenant.addDependency(this.connectionGroup);

      new route53.CnameRecord(this, `Cname-${tenant}`, {
        zone: hostedZone,
        recordName: tenant,
        domainName: routingEndpoint,
      });
    }
  }
}
