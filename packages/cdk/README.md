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
