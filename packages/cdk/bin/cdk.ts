#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BackendStack } from '../lib/backend-stack';
import { resolveConfig } from '../lib/config';
import { FrontendStack } from '../lib/frontend-stack';

const app = new cdk.App();

const config = resolveConfig((key) => app.node.tryGetContext(key));

// CloudFront 証明書は us-east-1 前提、API 本体は任意リージョン（東京など）。
// 本アプリは単一リージョン設計のため両スタックとも同じ env（CDK_DEFAULT_*）を共有する。
// リージョン跨ぎのスタック分割は対象外。certificateArn は ARN で渡され、
// CloudFront（グローバル / 証明書は us-east-1）が消費するため、スタックの
// デプロイリージョンに依存しない。
// 重要な不変条件: FrontendStack の Edge は API オリジンドメインを自スタックの
// region / urlSuffix から組み立てる（edge.ts 参照）。両スタックが同じ region を
// 共有していることが前提であり、ここで env を共有することがその担保になっている。
// フロントとバックエンドを別リージョンへ置く場合は edge.ts の apiOriginDomain の
// 解決方法を見直す必要がある。
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const backend = new BackendStack(app, 'BackendStack', {
  config,
  env,
});

const frontend = new FrontendStack(app, 'FrontendStack', {
  config,
  restApi: backend.restApi,
  originVerifySecret: backend.originVerifySecret,
  env,
});

// Backend → Frontend のデプロイ順序を強制する（Frontend は Backend の
// restApi / originVerifySecret を参照するため）。
frontend.addDependency(backend);
