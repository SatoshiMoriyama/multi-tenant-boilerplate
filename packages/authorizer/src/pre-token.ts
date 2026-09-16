import type { PreTokenGenerationTriggerHandler } from 'aws-lambda';

const TENANT_ATTRIBUTE = process.env.TENANT_ATTRIBUTE ?? 'custom:tenantId';

/**
 * Cognito pre-token-generation trigger。
 * ユーザー属性 custom:tenantId を ID トークンのクレームに載せる。
 * 属性が未設定のユーザーは、トークンにクレームを追加しない（Authorizer 側で拒否される）。
 */
export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  const tenantId = event.request.userAttributes?.[TENANT_ATTRIBUTE];

  if (tenantId) {
    event.response = {
      claimsOverrideDetails: {
        claimsToAddOrOverride: {
          [TENANT_ATTRIBUTE]: tenantId,
        },
      },
    };
  }

  return event;
};
