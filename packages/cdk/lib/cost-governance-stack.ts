import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';

export interface CostGovernanceStackProps extends StackProps {
  /** 予算超過・異常検知の通知先メールアドレス（チームの配信リスト推奨）。 */
  readonly alertEmail: string;
  /** 月次予算の上限（USD）。 */
  readonly monthlyBudgetUsd: number;
  /**
   * Cost Anomaly Detection の AWS サービスモニターを作るか。
   * AWS 管理のサービスモニターはアカウントあたり 1 個までという上限があるため、
   * 既に存在するアカウントでは false にする（サブスクリプションも作らない）。
   */
  readonly createAnomalyMonitor: boolean;
  /** 予算・モニター名のプレフィックス。既定はこのスタック名。 */
  readonly workloadName?: string;
}

/**
 * コストガバナンス専用スタック。
 *
 * 作るリソース:
 * - `AWS::Budgets::Budget`: 月次のコスト予算。予測 80% と実績 100% の 2 段で
 *   メール通知する。予測アラートは履歴が溜まるまで発火しないため、実績アラートが
 *   初日から効く側になる。
 * - `AWS::CE::AnomalyMonitor`: SERVICE ディメンションの AWS 管理モニター。
 *   サービス単位で個別に異常判定する（コンソール表記は「AWS サービス」）。
 * - `AWS::CE::AnomalySubscription`: 上記モニターに紐づく日次サマリー通知。
 *
 * BackendStack / FrontendStack を参照しない独立スタックにしている。予算のしきい値を
 * 変えてもアプリケーションリソースが再デプロイされないようにするため。
 *
 * 前提と制約:
 * - Cost Anomaly Detection は Cost Explorer が有効なアカウントでのみ動く。検知開始
 *   まで最大 24 時間、サービスごとに 10 日分の履歴が必要。
 * - Route 53 と ACM は Cost Anomaly Detection の対象外サービス。`Tenants` が作る
 *   Route 53 レコードのコストはこのモニターでは見えない。
 * - 予算にコストフィルターを付けていないため、対象はこのワークロードではなく
 *   アカウント全体になる。タグで絞るにはコスト配分タグの有効化が前提。
 */
export class CostGovernanceStack extends Stack {
  constructor(scope: Construct, id: string, props: CostGovernanceStackProps) {
    super(scope, id, props);

    const workloadName = props.workloadName ?? this.stackName;
    const budgetName = `${workloadName}-monthly-budget`;

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: props.monthlyBudgetUsd,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: [
        {
          // 予測が上限の 80% を超えた時点で先に知らせる（猶予を作る）。
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: props.alertEmail },
          ],
        },
        {
          // 実績が上限に達したら通知する。履歴に依存しないので初日から有効。
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: props.alertEmail },
          ],
        },
      ],
    });

    new CfnOutput(this, 'MonthlyBudgetName', { value: budgetName });

    if (!props.createAnomalyMonitor) {
      return;
    }

    const monitor = new ce.CfnAnomalyMonitor(this, 'ServiceAnomalyMonitor', {
      monitorName: `${workloadName}-service-monitor`,
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });

    new ce.CfnAnomalySubscription(this, 'ServiceAnomalySubscription', {
      subscriptionName: `${workloadName}-anomaly-subscription`,
      monitorArnList: [monitor.ref],
      subscribers: [{ type: 'EMAIL', address: props.alertEmail }],
      // DAILY = 日次サマリー。IMMEDIATE は SNS トピックが必須なので使わない。
      frequency: 'DAILY',
      // threshold（非推奨）と thresholdExpression は排他。thresholdExpression のみ
      // 指定する。両方渡すと CloudFormation が検証エラーで落ちる。
      // 影響額の絶対値が 10 USD 以上の異常だけ通知する。
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: ['10'],
        },
      }),
    });
  }
}
