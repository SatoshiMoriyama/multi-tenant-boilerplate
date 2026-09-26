/**
 * BackendStack / FrontendStack 共通の設定。既存リソースの参照や環境依存値は
 * cdk.json の context か、デプロイ時の -c で渡す。
 */
export interface BackendApiConfig {
  /** テナントサブドメインのベースドメイン（例: example.com） */
  readonly baseDomain: string;
  /**
   * 既存のワイルドカード ACM 証明書 ARN（*.example.com）。
   * us-east-1 に存在する前提。CloudFront に適用する。
   */
  readonly certificateArn: string;
  /** Route 53 ホストゾーンID（テナントCNAME作成に使用） */
  readonly hostedZoneId: string;
  /** フェーズ1で用意する pooled テナントのサブドメイン一覧（例: ["app"]） */
  readonly initialTenants: readonly string[];
  /**
   * CORS で許可するオリジンの明示リスト。SPA を配信するオリジンを列挙する。
   * 開発時は http://localhost:5173 など、本番は https://{tenant}.{baseDomain}。
   * 空なら CORS はどのオリジンにも許可を返さない（同一オリジン配信のみ想定）。
   * Hosted UI の callbackUrls / logoutUrls にもこの集合をそのまま使う
   * （SPA のオリジン = OAuth リダイレクト先のため）。
   */
  readonly allowedOrigins: readonly string[];
  /**
   * Cognito Hosted UI のデフォルトドメインのプレフィックス。
   * 実際のホスト名は {prefix}.auth.{region}.amazoncognito.com。
   * アカウント × リージョンで一意である必要がある。未指定なら Hosted UI を作らない。
   */
  readonly authDomainPrefix?: string;
}

const DEFAULTS = {
  baseDomain: 'example.com',
  initialTenants: ['app'],
  allowedOrigins: [] as readonly string[],
} as const;

/**
 * cdk context から設定を読み出す。必須値が無ければ即エラー。
 */
export function resolveConfig(
  getContext: (key: string) => unknown,
): BackendApiConfig {
  const certificateArn = getContext('certificateArn');
  const hostedZoneId = getContext('hostedZoneId');

  if (typeof certificateArn !== 'string' || certificateArn.length === 0) {
    throw new Error(
      "context 'certificateArn' is required (existing *.example.com cert ARN in us-east-1)",
    );
  }
  if (typeof hostedZoneId !== 'string' || hostedZoneId.length === 0) {
    throw new Error(
      "context 'hostedZoneId' is required (Route 53 hosted zone id)",
    );
  }

  const baseDomain = asString(getContext('baseDomain')) ?? DEFAULTS.baseDomain;
  const initialTenants = asStringArray(getContext('initialTenants')) ?? [
    ...DEFAULTS.initialTenants,
  ];
  const allowedOrigins = asStringArray(getContext('allowedOrigins')) ?? [
    ...DEFAULTS.allowedOrigins,
  ];
  const authDomainPrefix = asString(getContext('authDomainPrefix'));

  return {
    baseDomain,
    certificateArn,
    hostedZoneId,
    initialTenants,
    allowedOrigins,
    authDomainPrefix,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  return undefined;
}
