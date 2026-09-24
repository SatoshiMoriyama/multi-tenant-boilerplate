import { getIdToken } from './auth';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

/** GET /me のレスポンス。API（Hono）の /me が返す形。 */
export interface MeResponse {
  tenantId: string;
  headers: Record<string, string>;
}

/**
 * ID トークンを Authorization: Bearer で付けて API を叩く薄いラッパ。
 * ベースURLはテナントのオリジン（例 https://app.chelky.click）。CloudFront が
 * X-Origin-Verify / X-Tenant-Id を付与し、Lambda Authorizer を通る。
 */
async function apiFetch<T>(path: string): Promise<T> {
  const token = await getIdToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
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
