/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * API のベースURL。SPA と同一オリジンなら未設定でよい（相対 /api/... を叩く）。
   * ローカル開発では別オリジンの API を指す。例: https://app.example.com
   */
  readonly VITE_API_BASE_URL?: string;
  // Cognito の設定（User Pool ID / App Client ID / Hosted UI ドメイン）は
  // ビルド時の env ではなく、起動時に /tenant-config.json から実行時取得する
  // （App-client per tenant のため、テナントごとに clientId が異なる）。
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
