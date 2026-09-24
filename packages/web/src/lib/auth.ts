import {
  signOut as amplifySignOut,
  fetchAuthSession,
  getCurrentUser,
  signInWithRedirect,
} from 'aws-amplify/auth';

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
 * サインイン済みかどうかを返す。ルートの認証ガードで使う。
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    await getCurrentUser();
    return true;
  } catch {
    return false;
  }
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
