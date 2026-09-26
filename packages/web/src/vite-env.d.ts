/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * API のベースURL。SPA と同一オリジンなら未設定でよい（相対 /api/... を叩く）。
   * ローカル開発では別オリジンの API を指す。例: https://app.example.com
   */
  readonly VITE_API_BASE_URL?: string;
  /** Cognito User Pool ID。例: ap-northeast-1_xxxxxxxxx */
  readonly VITE_COGNITO_USER_POOL_ID: string;
  /** Cognito App Client ID */
  readonly VITE_COGNITO_USER_POOL_CLIENT_ID: string;
  /** Cognito Hosted UI ドメイン。例: xxx.auth.ap-northeast-1.amazoncognito.com */
  readonly VITE_COGNITO_HOSTED_UI_DOMAIN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
