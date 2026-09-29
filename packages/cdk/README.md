# CDK (マルチテナント Backend API)

このパッケージは、マルチテナント Backend API ボイラープレートのインフラを AWS CDK (TypeScript) で定義します。責務ごとに 2 つのスタックへ分割しています。

## スタック構成

- **`BackendStack`**（認証 / API）。以下を持ちます。
  - `Auth`: Cognito User Pool + App Client + pre-token-generation trigger
  - `Authorizer`: Lambda Authorizer（オリジン検証 + JWT + テナント一致）
  - `Api`: API Gateway (REST) + Lambda 統合 + Authorizer 紐付け
  - `OriginVerifySecret`: CloudFront から API Gateway へのオリジン検証シークレット
- **`FrontendStack`**（フロントエンド配信）。以下を持ちます。
  - `Edge`: CloudFront 親ディストリビューション + CloudFront Function + S3(SPA) + `BucketDeployment`
  - `Tenants`: distribution tenant / connection group (L1) + Route 53

`FrontendStack` は CloudFront オリジンとなる `restApi` と `originVerifySecret` を `BackendStack` から props（同一 app 内の cross-stack 参照）で受け取ります。`bin/cdk.ts` が `frontend.addDependency(backend)` を宣言するため、デプロイ順序は Backend → Frontend に固定されます。

- **`CostGovernanceStack`**（コストガードレール、opt-in）。context の `alertEmail` を指定したときだけ作られます。
  - `MonthlyBudget`: 月次コスト予算。予測 80% と実績 100% の 2 段でメール通知
  - `ServiceAnomalyMonitor` / `ServiceAnomalySubscription`: Cost Anomaly Detection の AWS サービスモニターと日次サマリー通知

`CostGovernanceStack` は他の 2 スタックを参照しません。予算のしきい値を変えてもアプリケーションリソースが再デプロイされないようにするためです。予算・異常検知はアカウント単位のリソースで、AWS 管理のサービスモニターはアカウントあたり 1 個までという上限があります。既に別の手段で作成済みのアカウントでは `createCostAnomalyMonitor=false` を渡して予算だけをデプロイしてください。

## context

`cdk.context.json` に置くか、デプロイ時に `-c key=value` で渡します。

| context | 必須 | 説明 |
| --- | --- | --- |
| `certificateArn` | ○ | CloudFront 用のワイルドカード ACM 証明書 ARN（us-east-1） |
| `hostedZoneId` | ○ | テナント CNAME を作成する Route 53 ホストゾーン ID |
| `baseDomain` | - | テナントサブドメインのベースドメイン（既定 `example.com`） |
| `initialTenants` | - | 用意するテナントのサブドメイン一覧（既定 `["app"]`） |
| `allowedOrigins` | - | CORS / Hosted UI で許可するオリジン一覧（既定 `[]`） |
| `authDomainPrefix` | - | Cognito Hosted UI のドメインプレフィックス（未指定なら Hosted UI を作らない） |
| `alertEmail` | - | コスト超過・異常検知の通知先メール。指定したときだけ `CostGovernanceStack` を作る |
| `monthlyBudgetUsd` | - | 月次予算の上限（USD、既定 `100`）。`alertEmail` 指定時のみ有効 |
| `createCostAnomalyMonitor` | - | Cost Anomaly Detection のモニターを作るか（既定 `true`）。`alertEmail` 指定時のみ有効 |
| `logRetention` | - | Lambda ロググループ 3 つの保持日数（既定 `30`）。`9999` は無期限 |

`logRetention` は CloudWatch Logs が受け付ける離散値のみ有効です（`1` `3` `5` `7` `14` `30` `60` `90` `120` `150` `180` `365` `400` `545` `731` `1096` `1827` `2192` `2557` `2922` `3288` `3653` `9999`）。それ以外を渡すと synth 時にエラーになります。dev / staging は `7`、本番は `90` 以上といった使い分けを想定しています。

## コマンド

```bash
pnpm build   # tsc で TypeScript をコンパイル
pnpm watch   # 変更を監視してコンパイル
pnpm test    # jest でユニットテスト
pnpm synth   # CloudFormation テンプレートを synth
pnpm diff    # デプロイ済みスタックと現状を比較
```

## デプロイ

`FrontendStack` の `Edge` は synth 時に `packages/web/dist` を読み込みます。`web/dist/index.html` があるときだけ `BucketDeployment` を作成する（無ければ警告のみ）ため、`FrontendStack` をデプロイする前に必ず `web:build`（リポジトリルートの `pnpm run web:build`）を実行してください。

スタックが 2 つあるので、デプロイ時は `--all` で両方を対象にします。`addDependency` により Backend → Frontend の順でデプロイされます。

```bash
npx cdk deploy --all \
  -c certificateArn=arn:aws:acm:us-east-1:<account-id>:certificate/<cert-id> \
  -c hostedZoneId=<Route53HostedZoneId> \
  --profile <your-profile>
```

リポジトリルートからは `pnpm cdk:deploy`（`web:build` 実行 + 両スタックデプロイ）/ `pnpm cdk:destroy`（両スタック削除）も使えます。

## 既存デプロイからの移行に関する警告

このパッケージは以前、単一スタック `BackendApiStack` にバックエンドとフロントエンド配信を同居させていました。現在はリソースを所有するスタックが `BackendStack` / `FrontendStack` に変わっています。CloudFormation はリソースをスタック名ごとに管理するため、**すでに `BackendApiStack` をデプロイ済みの環境へこの構成を `cdk deploy --all` でデプロイしても、旧 `BackendApiStack` は自動削除されません**。`cdk deploy --all` は現在の CDK app に定義されたスタック（`BackendStack` / `FrontendStack`）だけを作成・更新します。そのため**新しい 2 スタックが作成され、旧 `BackendApiStack` とそのリソースはそのまま残って並存します**。

各コンストラクト内のリソースのスタック相対な論理 ID は変えていませんが、論理 ID の安定はあくまで同一スタック内でのリソース差し替えを避けるためのものであり、スタック名をまたぐ移動には効きません。したがって既存環境では、Cognito User Pool（登録済みユーザーを含む）、CloudFront ディストリビューション（distribution tenant / ドメイン紐付けを含む）、S3 サイトバケット、API Gateway REST API が新スタック側にも作成され、旧 `BackendApiStack` のリソースと重複します（ドメイン紐付けなどでは競合の原因になります）。旧リソースはデプロイでは変更・削除されないため、新スタックへの移行とデータ検証が完了したうえで、`cdk destroy BackendApiStack`（または CloudFormation コンソールでの削除）を明示的に実行して片付けてください。

新規環境では問題ありませんが、既存環境を移行する場合は次のいずれかを検討してください（自動移行は提供しません）。

- 新環境として扱い、ユーザー / テナントを作り直す。移行完了後に旧 `BackendApiStack` を `cdk destroy BackendApiStack` で削除する。
- `cdk refactor`（スタックリファクタリング）や `cdk import`（リソースインポート）で、既存の User Pool / ディストリビューションを削除せずに新スタックへ引き継ぐ。
- 事前にステージングで `cdk diff` を確認し、新規作成されるリソースと旧 `BackendApiStack` に残って重複するリソースを把握する。
