import { getIdToken } from './auth';

// SPA と API は同一オリジンに同居する（例 https://app.example.com）。API は
// /api 配下。本番は同一オリジンなので空文字（相対 /api/... を叩く）でよい。
// ローカル開発では別オリジンの API を指すために設定する（例 https://app.example.com）。
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

/** GET /me のレスポンス。API（Hono）の /me が返す形。 */
export interface MeResponse {
  tenantId: string;
  headers: Record<string, string>;
}

/**
 * ID トークンを Authorization: Bearer で付けて API を叩く薄いラッパ。
 * API は同一オリジンの /api 配下（例 https://app.example.com/api）。CloudFront が
 * /api/* を API Gateway へ振り分け、X-Origin-Verify / X-Tenant-Id を付与し、
 * Lambda Authorizer を通る。path は "/me" のように渡す（/api は本関数が付ける）。
 */
async function apiFetch<T>(path: string): Promise<T> {
  const token = await getIdToken();
  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function getMe(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/me');
}
