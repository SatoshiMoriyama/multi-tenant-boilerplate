import { getCurrentTenantId } from '../lib/amplify';
import { signOut } from '../lib/auth';

/**
 * アクセス権が無いことを知らせる画面。
 *
 * 別テナントのトークンでこのサイト（ホスト）に来た場合に表示する。App-client per
 * tenant にしても同一 User Pool の Hosted UI セッション Cookie は共有されるため、
 * 別テナントで認証済みのユーザーが再入力なしにトークンを得られてしまう。API は
 * Authorizer が 403 で弾くが、画面遷移まで塞ぐためここへ誘導する。
 *
 * サインアウトは Cognito の /logout へ遷移し Hosted UI Cookie を消すので、正しい
 * テナントのアカウントでログインし直せる。
 */
export function ForbiddenPage() {
  const tenantId = getCurrentTenantId();

  async function handleSignOut() {
    await signOut();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-8">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-gray-200 bg-white p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">
          アクセス権がありません
        </h1>
        <p className="text-sm text-gray-600">
          ログイン中のアカウントは、このサイト
          {tenantId ? `（${tenantId}）` : ''}
          のテナントに所属していません。正しいテナントのアカウントでログインし直してください。
        </p>
        <button
          type="button"
          onClick={handleSignOut}
          className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700"
        >
          サインアウト
        </button>
      </div>
    </div>
  );
}
