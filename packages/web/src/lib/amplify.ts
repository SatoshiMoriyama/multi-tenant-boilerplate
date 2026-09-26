import { Amplify } from 'aws-amplify';

/**
 * /tenant-config.json のレスポンス。CloudFront Function (tenant-config.js) が
 * Host からテナントを解決し、そのテナント分だけを動的生成して返す。
 */
interface TenantConfig {
  tenantId: string;
  userPoolId: string;
  userPoolClientId: string;
  hostedUiDomain: string;
}

/**
 * テナント設定を取得するエンドポイント。CloudFront が Host を見て、この URL への
 * リクエストに対し「今アクセスしているテナント」の設定だけを返す（列挙されない）。
 * 開発時は別オリジンの CloudFront を指すため VITE_API_BASE_URL を前置する。
 */
const CONFIG_URL = `${import.meta.env.VITE_API_BASE_URL ?? ''}/tenant-config.json`;

async function fetchTenantConfig(): Promise<TenantConfig> {
  const res = await fetch(CONFIG_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load tenant config: ${res.status}`);
  }
  return (await res.json()) as TenantConfig;
}

// 現在アクセスしているホストのテナントID。configureAmplify() で /tenant-config.json
// から解決した値を保持し、認証ガードのテナント一致検証（auth.ts）で参照する。
let currentTenantId: string | undefined;

/**
 * 現在ホストのテナントID。configureAmplify() 完了後に確定する。
 * 認証ガードで「トークンの custom:tenantId と一致するか」を検証するために使う。
 */
export function getCurrentTenantId(): string | undefined {
  return currentTenantId;
}

/**
 * Amplify Auth を Cognito User Pool + Hosted UI 向けに設定する。
 *
 * App-client per tenant のため clientId はテナントごとに異なる。SPA は単一 dist を
 * 全テナントへ配信する（clientId をビルド時に焼き込めない）ので、起動時に
 * /tenant-config.json を取得し、今アクセスしているホストに対応する clientId を
 * 実行時に解決する。
 */
export async function configureAmplify(): Promise<void> {
  const cfg = await fetchTenantConfig();
  currentTenantId = cfg.tenantId;

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
        userPoolId: cfg.userPoolId,
        userPoolClientId: cfg.userPoolClientId,
        loginWith: {
          oauth: {
            domain: cfg.hostedUiDomain,
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
