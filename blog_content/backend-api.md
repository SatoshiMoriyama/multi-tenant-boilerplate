# Backend API 設計メモ（フェーズ1）

マルチテナントSaaSボイラープレートの最初のスコープ。CloudFront（マルチテナントディストリビューション） → API Gateway → Lambda と Cognito 認証。テナント別サブドメインでエッジからテナントを識別する。

## スコープ

- **対象**: Backend API + Cognito 認証 + テナント別サブドメイン
- **対象外（後続）**: フロントエンド本体、テナント管理/オンボーディングの作り込み、課金、SES、監視、SBT-AWS、サイロ型マルチアカウント
- **IaC**: 既存 `packages/cdk/`（AWS CDK v2 / TypeScript、`aws-cdk-lib` 2.232.1）

## アーキテクチャ

```
[Client] https://{tenant}.chelky.click
   |  HTTPS（ワイルドカード証明書 *.chelky.click）
   v
[CloudFront マルチテナントディストリビューション]
   ├─ 親: multi-tenant distribution（共有ブループリント。単体では配信しない）
   ├─ 子: distribution tenant（テナント別。ドメイン = {tenant}.chelky.click）
   ├─ connection group（ルーティングエンドポイント。テナントCNAMEの向き先）
   └─ CloudFront Function: Host から tenant を解決し X-Tenant-Id 付与
   |  origin + シークレットヘッダー X-Origin-Verify
   v
[API Gateway (REST API)]
   |  REQUEST型 Lambda Authorizer で認可（X-Origin-Verify 検証 + JWT + テナント一致）、ANY /{proxy+} プロキシ統合
   |  X-Amz-Tenant-Id ← context.authorizer.tenantId
   v
[Lambda (Node.js + Hono / Lambda-lith)]
```

## テナントID の2系統

- **Host 由来** `X-Tenant-Id`: CloudFront Function が Host から解決（認証前・JWT非検証）
- **JWT 由来** `custom:tenantId`: Cognito が pre-token-generation trigger で注入。Lambda Authorizer が署名検証して取得（信頼できる正）
- **一致検証**: Lambda Authorizer が両者を突合し不一致なら Deny。下流の `X-Amz-Tenant-Id` は常にJWT由来で詐称不可

## 決定事項

### 1. API Gateway: REST API
Lambda Authorizer、Usage Plans/API Keys（ティア別クォータ）、パラメータマッピングが必要なため。HTTP APIは `X-Amz-Tenant-Id` の override 不可で分離モードに使えない。

### 2. オリジン保護: CloudFront経由のみ許可
CloudFront がシークレットヘッダー `X-Origin-Verify`（Secrets Manager 管理）を付与し、**Lambda Authorizer で検証**する。CDK は `origins.RestApiOrigin` の `customHeaders`（親ディストリビューションのオリジン設定）で付与。
- API Gateway リソースポリシーは**使わない**。リソースポリシーの条件キーに任意 HTTP ヘッダーを参照するものが無く（`aws:RequestHeader` は存在しない）、`X-Origin-Verify` を条件評価できないため。
- WAF での string match 検証（[AWS公式パターン](https://aws.amazon.com/blogs/security/how-to-enhance-amazon-cloudfront-origin-security-with-aws-waf-and-aws-secrets-manager/)）も選択肢だが、常時コストが増えるため採用しない。認可を担う Lambda Authorizer に集約する。
- シークレットローテーション、より堅牢な SigV4署名（Lambda@Edge）は要件が出た段階で追加。

### 3. 認可: REQUEST型 Lambda Authorizer
JWT検証 + テナント一致検証 + オリジン検証 + テナントID供給を1箇所に集約。Cognitoネイティブ Authorizer は検証のみで一致チェック・context加工ができないため採用しない。
- `identitySource`: `Authorization` + `X-Tenant-Id` + `X-Origin-Verify`（組み合わせ単位でキャッシュ）。いずれか欠落時は API Gateway が Authorizer を呼ばず 401
- 処理: `X-Origin-Verify` とシークレットを突合（不一致は Deny）→ JWT検証（`aws-jwt-verify`）→ `custom:tenantId` 取得 → `X-Tenant-Id` と突合（不一致は Deny）→ `context.tenantId`（JWT由来）返却
- 期待挙動: 直叩き（`X-Origin-Verify` なし）→ 401 / CloudFront経由・認証なし → Deny(403) / 正しいIDトークン+tenantId一致 → 200

### 4. ドメイン/証明書: `{tenant}.chelky.click`
ワイルドカード ACM 証明書 `*.chelky.click`（`us-east-1` 必須）を親に設定。`chelky.click` は Route 53 管理なので DNS検証を CDK 自動化。テナント CNAME はオンボーディング時に作成。

### 5. CloudFront キャッシュ
認証付きAPIはキャッシュ無効（`Authorization` 転送）。静的アセットのみ path pattern 別に有効化。

### 6. Lambda: Node.js(TypeScript) + Hono / Lambda-lith
`hono/aws-lambda` の `handle(app)` を全ルート集約（ルーティングは Hono）。`ANY /{proxy+}` プロキシ統合。CDK は `NodejsFunction`（esbuild）。テナントは `context.authorizer.tenantId` を正として解決。関数分割しない。全ルートが同一実行ロールを共有（細粒度権限が要る段階でトークンベンディング検討）。

### 7. CloudFront SaaS Manager（マルチテナントディストリビューション）
- **親**: L2 `Distribution` + L1 `CfnDistribution` で `connectionMode: "tenant-only"` とパラメータ定義。オリジンは API Gateway
- **子**: L1 `CfnDistributionTenant`（`distributionId` / `domains` / `name` / `parameters` / `connectionGroupId` / 証明書・WAFは `customizations` 上書き）
- **connection group**: L1 `CfnConnectionGroup`（省略時はデフォルト）
- distribution tenant / connection group は **L1 のみ**。`name` は作成後変更不可
- **tier**: Basic = 単一 pooled tenant + `*.chelky.click`（追加はDNSのみ）。Premium = tenant別に専用証明書/WAFで silo 化

### 8. Lambda テナント分離モード（tier 別）
`TenancyConfig.TenantIsolationMode: PER_TENANT` でテナントIDごとに実行環境（Firecracker）を分離。クロステナント漏洩を実行環境レベルで防ぐ。
- **供給元**: `X-Amz-Tenant-Id` ← `context.authorizer.tenantId`（JWT由来）を `integration.request.header.X-Amz-Tenant-Id` にマッピング。API Gateway REST API の Lambda proxy integration で利用
- **対応リージョン**: NZ（ap-southeast-6）を除く全商用。東京 ap-northeast-1 可
- **制限**: function URLs / provisioned concurrency / SnapStart と併用不可。immutable（作成時のみ）。実行ロール全テナント共通。同時実行1,000あたり分離環境2,500上限。作成ごと追加課金 + コールドスタック増
- **使い分け**: Basic = 論理分離のみ（Hono middleware）。Premium/規制 = 分離モード有効

## CDK構成

```
packages/cdk/lib/
  backend-api-stack.ts  … BackendApiStack。各コンストラクトを組み立て
  constructs/
    auth.ts             … Cognito User Pool + App Client + pre-token-generation trigger
    api.ts              … API Gateway(REST) + Lambda統合 + Authorizer紐付け + X-Amz-Tenant-Idマッピング
    authorizer.ts       … Lambda Authorizer（X-Origin-Verify検証 + JWT検証 + テナント一致検証）
    edge.ts             … CloudFront 親ディストリビューション + CloudFront Function
    tenants.ts          … distribution tenant / connection group（L1）+ Route53 レコード

packages/
  api/src/              … Hono アプリ（index.ts=handle(app), app.ts=ルーター, middleware/tenant.ts）
  authorizer/src/       … Lambda Authorizer（index.ts=JWT検証 + 一致検証 + context.tenantId返却）
```

ワイルドカード ACM 証明書は `us-east-1` 必須。証明書を `us-east-1` の別スタックに分けるか `crossRegionReferences` で解決。

## 動作確認（JWT払い出し〜curl）

デプロイ後のエンドツーエンド検証手順。`<...>` は `cdk deploy` の Outputs（`UserPoolId` / `UserPoolClientId` / `RestApiId`）に置き換える。

### 1. テストユーザー作成

```bash
POOL=<UserPoolId>          # 例: ap-northeast-1_xxxxxxxxx
USER=test-app@example.com
PASS='Test-Passw0rd!2026'

# custom:tenantId=app を付けて作成（app = 検証対象テナントのサブドメイン）
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$USER" \
  --user-attributes Name=email,Value="$USER" Name=email_verified,Value=true Name=custom:tenantId,Value=app \
  --message-action SUPPRESS --profile chelky

# 恒久パスワードを設定（FORCE_CHANGE_PASSWORD を解除）
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$USER" \
  --password "$PASS" --permanent --profile chelky
```

### 2. IDトークン払い出し

App Client は既定で SRP のみ有効なため、CLI から直接パスワード認証するには `ADMIN_USER_PASSWORD_AUTH` を一時的に有効化する（検証専用。本番運用では有効化しない）。

```bash
CLIENT=<UserPoolClientId>

# 検証用に admin パスワード認証フローを一時有効化
aws cognito-idp update-user-pool-client --user-pool-id "$POOL" --client-id "$CLIENT" \
  --explicit-auth-flows ALLOW_ADMIN_USER_PASSWORD_AUTH ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --profile chelky

# IDトークン取得（tokenUse=id を検証しているのでアクセストークンではなく ID トークンを使う）
ID_TOKEN=$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL" --client-id "$CLIENT" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$USER",PASSWORD="$PASS" \
  --profile chelky --query 'AuthenticationResult.IdToken' --output text)

# クレーム確認（custom:tenantId が入っていること）
echo "$ID_TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | python3 -m json.tool
```

### 3. curl 検証（CloudFront 経由 = 正しい経路）

`{tenant}.chelky.click`（例 `app.chelky.click`）に、`Authorization: Bearer <IDトークン>` を付けてアクセスする。`X-Tenant-Id` はクライアントが付けても CloudFront Function が Host から上書きするので送らなくてよい。

```bash
BASE=https://app.chelky.click

# 正常系: 200
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $ID_TOKEN" "$BASE/health"   # {"status":"ok"}
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $ID_TOKEN" "$BASE/me"       # {"tenantId":"app"}
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $ID_TOKEN" "$BASE/items"    # {"tenantId":"app","items":[]}

# 認証なし: 401（identity source 不足で Authorizer 未起動）
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/health"
```

### 4. セキュリティ動作の確認

```bash
API=https://<RestApiId>.execute-api.ap-northeast-1.amazonaws.com/v1

# 直叩き（X-Origin-Verify なし）: 401
curl -s -o /dev/null -w '%{http_code}\n' "$API/health"

# 直叩き + 偽の X-Origin-Verify（3ヘッダ揃えて Authorizer を起動させても弾かれる）: 403
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $ID_TOKEN" -H "X-Tenant-Id: app" -H "X-Origin-Verify: wrong" \
  "$API/health"

# テナント詐称（CloudFront経由で X-Tenant-Id: other を送る）: CloudFront Function が app に上書き → 200
# クライアントはテナントを詐称できず、アクセス元サブドメインのテナントに束縛される
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $ID_TOKEN" -H "X-Tenant-Id: other" "$BASE/me"  # {"tenantId":"app"}
```

期待値: 直叩き=401 / 偽シークレット=403 / 認証なし=401 / 正常系=200 / 詐称=app に矯正。

## 参照（memo.md）

Cognito §1.1 / API Gateway §2.3 / Lambda §2.1 / CloudFront §5.1 / ACM・ドメイン §5.3
