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
