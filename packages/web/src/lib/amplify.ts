import { Amplify } from 'aws-amplify';

/**
 * Amplify Auth を Cognito User Pool + Hosted UI 向けに設定する。
 * ログインは Hosted UI（OAuth Authorization Code + PKCE）へリダイレクトして行う。
 * 値は環境変数から。
 */
export function configureAmplify(): void {
  // OAuth のリダイレクト先は「今アプリを開いているオリジン」を実行時に決める。
  // Amplify v6 は redirectSignIn の中から window.location.origin に一致するものを
  // 選び、無いと "redirect is coming from a different origin" で失敗する。ビルド時に
  // 固定値を焼き込むと本番/ローカルでオリジンがズレて壊れるため、env には頼らない。
  // Cognito App Client の callbackUrls/logoutUrls にこのオリジンが登録されていること。
  // 末尾スラッシュは付けない（Cognito 登録値と完全一致させる。ズレると redirect_mismatch）。
  const redirectUrl = window.location.origin;

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
