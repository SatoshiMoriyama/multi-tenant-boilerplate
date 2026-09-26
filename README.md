# マルチテナント Backend API ボイラープレート

CloudFront マルチテナントディストリビューション（SaaS Manager）と Lambda Authorizer でテナント分離を実装した、バックエンド API のボイラープレートです。テナントごとにサブドメイン（`app.example.com` のような形）を切って配信し、Host 由来の tenantId と JWT 由来の tenantId を Lambda Authorizer で突き合わせてテナントを分離します。

## アーキテクチャ

```text
[Client] https://{tenant}.example.com
   |  HTTPS（ワイルドカード証明書 *.example.com）
   v
[CloudFront マルチテナントディストリビューション]
   ├─ 親: multi-tenant distribution（共有ブループリント。単体では配信しない）
   ├─ distribution tenant（テナント別。ドメイン = {tenant}.example.com）
   ├─ connection group（ルーティングエンドポイント。テナント CNAME の向き先）
   └─ CloudFront Function: Host から tenant を解決し X-Tenant-Id を付与
   |  origin にシークレットヘッダー X-Origin-Verify を付与
   v
[API Gateway (REST API)]
   |  REQUEST 型 Lambda Authorizer で認可、ANY /{proxy+} プロキシ統合
   v
[Lambda (Node.js + Hono / Lambda-lith)]
```

- **テナント識別**: CloudFront Function が Host（サブドメイン）から tenantId を解決し `X-Tenant-Id` を付与
- **認可**: REQUEST 型 Lambda Authorizer が、オリジン検証（`X-Origin-Verify`）・JWT 検証・テナント一致検証をまとめて実施
- **正となる tenantId**: Cognito の ID トークンに載る `custom:tenantId`（署名検証済み）。Host 由来と一致したときだけ通し、下流には JWT 由来の値だけを渡す
- **テナント分離モード**: Lambda のテナント分離モード（tenant isolation mode）を既定で有効化。Authorizer が返す JWT 由来の tenantId を `X-Amz-Tenant-Id` にマッピングし、テナント単位に実行環境を分離

設計の詳細は `blog_content/blog.md` を参照してください。

## パッケージ構成

pnpm workspace のモノレポです。

- `packages/api/` - バックエンド API 本体（Hono / Lambda-lith）
- `packages/authorizer/` - Lambda Authorizer と Cognito pre-token-generation trigger
- `packages/cdk/` - AWS CDK（`BackendStack` / `FrontendStack` とコンストラクト群）
- `blog_content/` - 設計解説のブログ記事

CDK は `packages/cdk/lib/` に、責務ごとに分けた 2 スタックとコンストラクト 5 つで構成しています。バックエンド（認証 / API）とフロントエンド配信（CloudFront + S3）のライフサイクルを分離し、片方だけのデプロイ・再作成をしやすくしています。

```text
packages/cdk/lib/
  backend-stack.ts      … BackendStack。Auth / Authorizer / Api / OriginVerifySecret を組み立て
  frontend-stack.ts     … FrontendStack。Edge / Tenants を組み立て（CloudFront + S3 配信）
  constructs/
    auth.ts             … Cognito User Pool + App Client + pre-token trigger
    api.ts              … API Gateway(REST) + Lambda 統合 + Authorizer 紐付け
    authorizer.ts       … Lambda Authorizer（オリジン検証 + JWT + テナント一致）
    edge.ts             … CloudFront 親ディストリビューション + CloudFront Function + S3(SPA) + BucketDeployment
    tenants.ts          … distribution tenant / connection group（L1）+ Route53
```

コンストラクトの構成は変わっていません。`BackendStack` が Auth / Authorizer / Api とオリジン検証シークレット（`OriginVerifySecret`）を持ち、`FrontendStack` が Edge / Tenants を持ちます。`FrontendStack` は CloudFront オリジンとなる `restApi` と `originVerifySecret` を `BackendStack` から受け取るため、`bin/cdk.ts` で `frontend.addDependency(backend)` を宣言し、Backend → Frontend の順にデプロイされるようにしています。

## 前提

- Node.js / pnpm
- デプロイ先の AWS アカウントで CDK ブートストラップ済みであること
- ワイルドカードの ACM 証明書（`*.example.com`）が **us-east-1** に存在すること（CloudFront 用）
- テナントサブドメインを引く Route 53 ホストゾーンがあること

検証は 2026 年 9 月時点、アジアパシフィック（東京）リージョン（`ap-northeast-1`）、`aws-cdk-lib` 2.232.1、AWS Lambda の Node.js ランタイム 22 で行いました。

## デプロイ

依存関係をインストールします。

```bash
pnpm install
```

CDK app には `BackendStack`（認証 / API）と `FrontendStack`（CloudFront + S3 配信）の 2 スタックがあります。`FrontendStack` は `BackendStack` の `restApi` / `originVerifySecret` を参照するため、`bin/cdk.ts` の `frontend.addDependency(backend)` により Backend → Frontend の順でデプロイされます。スタックが 2 つになったので、デプロイ時は `--all` で両方を指定する（または両スタック名を明示する）必要があります。

`FrontendStack` の `Edge` は synth 時に `packages/web/dist` を読み込みます。`web/dist/index.html` が存在するときだけ `BucketDeployment` を作成する（無ければ警告のみで throw はしない）ため、`FrontendStack` をデプロイする前に必ず `web:build` を実行し、フロントの成果物を用意してください。

必須の context を渡してデプロイします。`certificateArn` と `hostedZoneId` は環境固有値で、未指定だと synth / deploy がエラーになります。

```bash
pnpm run web:build   # FrontendStack の synth が web/dist を拾えるよう先にビルド
cd packages/cdk
npx cdk deploy --all \
  -c certificateArn=arn:aws:acm:us-east-1:<account-id>:certificate/<cert-id> \
  -c hostedZoneId=<Route53HostedZoneId> \
  --profile <your-profile>
```

### 既存デプロイからの移行に関する警告

このスタック分割は、旧来の単一スタック `BackendApiStack` から `BackendStack` / `FrontendStack` へと、リソースを所有する CloudFormation スタック名を変更します。CloudFormation はリソースをスタック名ごとに管理するため、**すでに `BackendApiStack` をデプロイ済みの環境に対してこの構成を `cdk deploy --all` でデプロイしても、旧 `BackendApiStack` は自動削除されません**。`cdk deploy --all` は現在の CDK app に定義されたスタック（`BackendStack` / `FrontendStack`）だけを作成・更新するため、**新しい 2 スタックが作成され、旧 `BackendApiStack` とそのリソースはそのまま残って並存します**。旧スタックのリソースはデプロイでは一切変更・削除されません。とくに次のリソースが重複して作成される点に注意してください（Cognito User Pool や CloudFront ドメイン紐付けなどは重複・競合の原因になります）。

- **Cognito User Pool**（新旧が並存し、登録済みユーザーは旧 Pool に残る）
- **CloudFront ディストリビューション**（および distribution tenant / ドメイン紐付け）
- **S3 サイトバケット** と **API Gateway REST API**

旧 `BackendApiStack` を片付けるには、新スタックへの移行とデータ検証が完了したうえで、`cdk destroy BackendApiStack`（または CloudFormation コンソールでの削除）を明示的に実行してください。移行前に旧スタックを削除すると、登録済みユーザーなどが失われます。

新規環境（グリーンフィールド）ではそのままデプロイして問題ありません。既存環境を移行する場合は、以下のいずれかの方針を検討してください（本ボイラープレートは自動移行を提供しません）。

- 新環境として扱い、ユーザーやテナントを新スタックへ作り直す（ダウンタイムやユーザー再登録を許容できる場合）。移行完了後に旧 `BackendApiStack` を `cdk destroy BackendApiStack` で削除する。
- CDK のスタックリファクタリング（`cdk refactor`）やリソースインポート（`cdk import`）を用いて、既存の User Pool / ディストリビューションを削除せずに新スタックへ引き継ぐ。
- 移行前に必ずステージング環境で `cdk diff` を確認し、新規に作成されるリソースと、旧 `BackendApiStack` に残って重複するリソースを把握する。

context は `cdk.context.json` に置くか、デプロイ時に `-c` で渡します。

| context | 必須 | 説明 |
| --- | --- | --- |
| `certificateArn` | ○ | CloudFront 用のワイルドカード ACM 証明書 ARN（us-east-1） |
| `hostedZoneId` | ○ | テナント CNAME を作成する Route 53 ホストゾーン ID |
| `baseDomain` | - | テナントサブドメインのベースドメイン（既定 `example.com`） |
| `initialTenants` | - | 用意するテナントのサブドメイン一覧（既定 `["app"]`） |
| `allowedOrigins` | - | CORS / Hosted UI で許可するオリジン一覧（既定 `[]`） |
| `authDomainPrefix` | - | Cognito Hosted UI のドメインプレフィックス（未指定なら Hosted UI を作らない） |

デプロイが終わると Outputs に、`BackendStack` から `UserPoolId` / `UserPoolClientId` / `RestApiId`（`authDomainPrefix` 指定時は `HostedUiDomain` も）が、`FrontendStack` から `DistributionId` / `SiteBucketName` が出ます。動作確認の手順は `blog_content/blog.md` の「動かしてみる」を参照してください。

ルートからは以下でも実行できます。

```bash
pnpm cdk:deploy    # CDK デプロイ
pnpm cdk:destroy   # CDK スタック削除
```

## 開発コマンド

```bash
# コードの lint
pnpm code:lint

# コードの lint（自動修正）
pnpm code:fix

# ブログ Markdown の lint
pnpm lint

# ブログ Markdown の lint（自動修正）
pnpm lint:fix
```

CDK パッケージ単体のビルド・テストは `packages/cdk` で実行します。

```bash
cd packages/cdk
pnpm build   # tsc
pnpm test    # jest
```
