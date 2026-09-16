#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { resolveConfig } from '../lib/config';
import { BackendApiStack } from '../lib/backend-api-stack';

const app = new cdk.App();

const config = resolveConfig((key) => app.node.tryGetContext(key));

new BackendApiStack(app, 'BackendApiStack', {
  config,
  // CloudFront 証明書は us-east-1 前提。API 本体は任意リージョン（東京など）。
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
