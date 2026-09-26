/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API のベースURL。テナントのオリジン。例: https://app.chelky.click */
  readonly VITE_API_BASE_URL: string;
  /** Cognito User Pool ID。例: ap-northeast-1_xxxxxxxxx */
  readonly VITE_COGNITO_USER_POOL_ID: string;
  /** Cognito App Client ID */
  readonly VITE_COGNITO_USER_POOL_CLIENT_ID: string;
  /** Cognito Hosted UI ドメイン。例: xxx.auth.ap-northeast-1.amazoncognito.com */
  readonly VITE_COGNITO_HOSTED_UI_DOMAIN: string;
  /** OAuth リダイレクト先。SPA のオリジン。例: http://localhost:5173 */
  readonly VITE_REDIRECT_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
