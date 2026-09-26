import {
  signOut as amplifySignOut,
  fetchAuthSession,
  getCurrentUser,
  signInWithRedirect,
} from 'aws-amplify/auth';
import { getCurrentTenantId } from './amplify';

/** ID トークンに載るテナントクレーム名（Authorizer / pre-token と一致させる）。 */
const TENANT_CLAIM = 'custom:tenantId';

/**
 * Cognito Hosted UI へリダイレクトしてサインインする（OAuth Code + PKCE）。
 * ブラウザが Hosted UI に遷移し、認証後は redirectSignIn（SPA のオリジン）に
 * code 付きで戻る。トークン交換は Amplify が自動で行う。
 */
export async function signIn(): Promise<void> {
  await signInWithRedirect();
}

/**
 * サインアウトする。Hosted UI 構成では Cognito のログアウトエンドポイントにも
 * 遷移し、redirectSignOut に戻る。
 */
export async function signOut(): Promise<void> {
  await amplifySignOut();
}

/**
 * 認証ガードの判定結果。
 * - 'authenticated': 有効なトークンがあり、テナントも一致（ダッシュボード表示可）
 * - 'unauthenticated': トークンが無い（通常のログイン導線へ = signIn）
 * - 'wrong-tenant': 有効なトークンはあるが別テナント（signIn へは行かせない）
 *
 * 3値に分けるのは無限ループ回避のため。'wrong-tenant' で signIn を呼ぶと、
 * 同一 User Pool の Hosted UI セッション Cookie が生きているため再入力なしで
 * 同じ別テナントのトークンが再発行され、また 'wrong-tenant' になる…を繰り返す。
 * このケースは signIn せず締め出す（呼び出し側で signOut / エラー表示）。
 */
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'wrong-tenant';

/**
 * 認証状態を返す。ルートの認証ガードで使う。
 *
 * トークンが有効なだけでなく、トークンの custom:tenantId が「今アクセスして
 * いるホストのテナント」と一致することも確認する。App-client per tenant にしても
 * 同一 User Pool の Hosted UI セッション Cookie は共有されるため、tenant-a の
 * ユーザーが tenant-b のサイトで再入力なしにトークンを得られてしまう（API は
 * Authorizer が 403 で弾くが、画面には入れてしまう）。ここで tenantId を突合する。
 */
export async function getAuthStatus(): Promise<AuthStatus> {
  try {
    await getCurrentUser();
  } catch {
    return 'unauthenticated';
  }

  const session = await fetchAuthSession();
  const tokenTenantId = session.tokens?.idToken?.payload?.[TENANT_CLAIM];
  const currentTenantId = getCurrentTenantId();

  if (
    !currentTenantId ||
    typeof tokenTenantId !== 'string' ||
    tokenTenantId !== currentTenantId
  ) {
    return 'wrong-tenant';
  }

  return 'authenticated';
}

/**
 * 現在の ID トークンを返す。API 呼び出しの Authorization: Bearer に使う。
 * Authorizer は ID トークン（custom:tenantId を含む）を検証するため、
 * access トークンではなく ID トークンを使う。
 */
export async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error('ID トークンを取得できません');
  }
  return idToken;
}
