import { Amplify } from 'aws-amplify';

/**
 * Amplify Auth を Cognito User Pool + Hosted UI 向けに設定する。
 * ログインは Hosted UI（OAuth Authorization Code + PKCE）へリダイレクトして行う。
 * 値は環境変数から。
 */
export function configureAmplify(): void {
  const redirectUrl = import.meta.env.VITE_REDIRECT_URL;

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
        loginWith: {
          oauth: {
            domain: import.meta.env.VITE_COGNITO_HOSTED_UI_DOMAIN,
            scopes: ['openid', 'email', 'profile'],
            redirectSignIn: [redirectUrl],
            redirectSignOut: [redirectUrl],
            responseType: 'code',
          },
        },
      },
    },
  });
}
