import { useQuery } from '@tanstack/react-query';
import { getMe } from '../lib/api';
import { signOut } from '../lib/auth';

export function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
  });

  // Hosted UI 構成では signOut が Cognito のログアウトエンドポイントへ遷移し、
  // redirectSignOut（/）に戻る。戻った後 beforeLoad が未認証を検知して
  // 再び Hosted UI へ飛ばすため、ここでの明示的な navigate は不要。
  async function handleSignOut() {
    await signOut();
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-900">
            ダッシュボード
          </h1>
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            ログアウト
          </button>
        </div>

        {isLoading && <p className="text-gray-600">読み込み中…</p>}

        {error && (
          <p className="text-red-600">
            取得に失敗しました: {error instanceof Error ? error.message : ''}
          </p>
        )}

        {data && (
          <div className="space-y-4">
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-sm text-gray-500">tenantId</p>
              <p className="text-lg font-medium text-gray-900">
                {data.tenantId}
              </p>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="mb-2 text-sm text-gray-500">
                GET /me レスポンスヘッダ
              </p>
              <pre className="overflow-x-auto rounded bg-gray-900 p-3 text-xs text-gray-100">
                {JSON.stringify(data.headers, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
