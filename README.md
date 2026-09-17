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
- `packages/cdk/` - AWS CDK（`BackendApiStack` とコンストラクト群）
- `blog_content/` - 設計解説のブログ記事

CDK は `packages/cdk/lib/` に、スタック本体とコンストラクト 5 つで構成しています。

```text
packages/cdk/lib/
  backend-api-stack.ts  … BackendApiStack。各コンストラクトを組み立て
  constructs/
    auth.ts             … Cognito User Pool + App Client + pre-token trigger
    api.ts              … API Gateway(REST) + Lambda 統合 + Authorizer 紐付け
    authorizer.ts       … Lambda Authorizer（オリジン検証 + JWT + テナント一致）
    edge.ts             … CloudFront 親ディストリビューション + CloudFront Function
    tenants.ts          … distribution tenant / connection group（L1）+ Route53
```

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

必須の context を渡してデプロイします。`certificateArn` と `hostedZoneId` は環境固有値で、未指定だと synth / deploy がエラーになります。

```bash
cd packages/cdk
npx cdk deploy \
  -c certificateArn=arn:aws:acm:us-east-1:<account-id>:certificate/<cert-id> \
  -c hostedZoneId=<Route53HostedZoneId> \
  --profile <your-profile>
```

context は `cdk.context.json` に置くか、デプロイ時に `-c` で渡します。

| context | 必須 | 説明 |
| --- | --- | --- |
| `certificateArn` | ○ | CloudFront 用のワイルドカード ACM 証明書 ARN（us-east-1） |
| `hostedZoneId` | ○ | テナント CNAME を作成する Route 53 ホストゾーン ID |
| `baseDomain` | - | テナントサブドメインのベースドメイン（既定 `example.com`） |
| `initialTenants` | - | 用意するテナントのサブドメイン一覧（既定 `["app"]`） |

デプロイが終わると Outputs に `UserPoolId` / `UserPoolClientId` / `RestApiId` / `DistributionId` が出ます。動作確認の手順は `blog_content/blog.md` の「動かしてみる」を参照してください。

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
