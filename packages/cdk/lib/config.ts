import type * as logs from 'aws-cdk-lib/aws-logs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

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
  /**
   * コスト超過・異常検知の通知先メールアドレス。
   * 指定したときだけ CostGovernanceStack を作る（未指定ならスタック自体を作らない）。
   * 個人のアドレスではなくチームの配信リストを指定する。購読が古くなると
   * ガードレールが無言で失効するため。
   */
  readonly alertEmail?: string;
  /**
   * 月次予算の上限（USD）。alertEmail 指定時のみ有効。
   * 既定 100 はプレースホルダで、実際の値は Cost Explorer の 30 日実績を
   * ベースラインにして決める。低すぎると誤検知でアラート疲れを招く。
   */
  readonly monthlyBudgetUsd?: number;
  /**
   * Cost Anomaly Detection の AWS サービスモニターを作るか（既定 true）。
   * AWS 管理のサービスモニターはアカウントあたり 1 個までなので、既に
   * 別の手段で作成済みのアカウントでは false にしてデプロイ失敗を避ける。
   */
  readonly createCostAnomalyMonitor?: boolean;
  /**
   * 3 つの Lambda ロググループ（HandlerLogs / PreTokenTriggerLogs / FunctionLogs）
   * の保持期間。未指定なら各コンストラクト側の既定 ONE_MONTH（30 日）。
   * dev / staging は 7、本番は 90 以上といった使い分けを想定する。
   * 9999 は無期限保持（RetentionInDays を出力しない）。
   */
  readonly logRetention?: logs.RetentionDays;
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

  // コストガバナンスは opt-in。alertEmail が無ければ関連 context を一切読まない
  // （既存の BackendStack / FrontendStack は alertEmail 無しで synth できる）。
  const alertEmail = asString(getContext('alertEmail'));
  const monthlyBudgetUsd =
    alertEmail === undefined
      ? undefined
      : resolveMonthlyBudgetUsd(getContext('monthlyBudgetUsd'));
  const createCostAnomalyMonitor =
    alertEmail === undefined
      ? undefined
      : (asBoolean(getContext('createCostAnomalyMonitor')) ?? true);

  const logRetention = resolveLogRetention(getContext('logRetention'));

  return {
    baseDomain,
    certificateArn,
    hostedZoneId,
    initialTenants,
    allowedOrigins,
    authDomainPrefix,
    alertEmail,
    monthlyBudgetUsd,
    createCostAnomalyMonitor,
    logRetention,
  };
}

/**
 * CloudWatch Logs の保持期間を context から解決する。未指定なら undefined
 * （各コンストラクトの既定 ONE_MONTH にフォールバック）。
 *
 * cdk.context.json では数値、`-c logRetention=7` では文字列で渡るため両方受ける。
 * CloudWatch Logs が受け付ける値は離散的なので、RetentionDays の列挙値に
 * 無い数値は synth 時に落とす（デプロイ時の API エラーまで持ち越さない）。
 */
function resolveLogRetention(raw: unknown): logs.RetentionDays | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!VALID_RETENTION_DAYS.has(value)) {
    throw new Error(
      `context 'logRetention' must be one of ${[...VALID_RETENTION_DAYS].join(', ')} (got ${String(raw)}). 9999 means infinite retention.`,
    );
  }
  return value as logs.RetentionDays;
}

/** RetentionDays の数値メンバー（9999 = INFINITE を含む）。 */
const VALID_RETENTION_DAYS: ReadonlySet<number> = new Set(
  Object.values(RetentionDays).filter(
    (v): v is number => typeof v === 'number',
  ),
);

/** 月次予算の上限（USD）。未指定なら既定 100。正の有限数でなければエラー。 */
const DEFAULT_MONTHLY_BUDGET_USD = 100;

function resolveMonthlyBudgetUsd(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_MONTHLY_BUDGET_USD;
  }
  // -c monthlyBudgetUsd=200 は文字列で渡るため数値化する。
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      "context 'monthlyBudgetUsd' must be a positive number (USD)",
    );
  }
  return value;
}

/** テナント1件分の App Client 構成（tenantId とその callback オリジン）。 */
export interface TenantClientDef {
  readonly tenantId: string;
  readonly callbackOrigins: readonly string[];
}

/**
 * App-client per tenant 用に、テナントごとの callback オリジンを組み立てる。
 *
 * allowedOrigins の各エントリは次の3種類に分類する:
 * - (a) いずれかの initialTenant について https://{tenant}.{baseDomain} と
 *   完全一致するもの: そのテナントの client にだけ割り当てる。
 * - (b) ホストが baseDomain 配下のテナント形式サブドメイン（{label}.{baseDomain}）
 *   だが、initialTenants に登録が無い未登録テナントや表記揺れのもの:
 *   どの client にも追加しない（拒否・スキップ）。共有 dev オリジン扱いにしない。
 *   これにより tenant-a / tenant-b の全 client が別テナント URL（例:
 *   https://tenant-c.example.com）へリダイレクトできてしまう問題を防ぐ。
 * - (c) baseDomain 配下でないオリジン（http://localhost:5173 など）:
 *   ローカル開発ではホスト名でテナントを判別できないため、共有 dev オリジンとして
 *   全テナントの client に追加する。
 *
 * ホスト判定は部分文字列の一致に騙されないよう、URL コンストラクタで host を
 * パースして行う。各テナントの callbackOrigins は
 * 「自サブドメイン https://{tenantId}.{baseDomain} + 自テナントに一致した
 * allowedOrigins エントリ + 共有 dev オリジン」を重複除去しつつ決定的な順序で組む。
 */
export function buildTenantClients(
  config: Pick<
    BackendApiConfig,
    'baseDomain' | 'initialTenants' | 'allowedOrigins'
  >,
): TenantClientDef[] {
  const { baseDomain, initialTenants, allowedOrigins } = config;

  // initialTenant のサブドメインホスト（例: tenant-a.example.com）→ tenantId。
  const tenantByHost = new Map(
    initialTenants.map((t) => [`${t}.${baseDomain}`.toLowerCase(), t]),
  );
  const suffix = `.${baseDomain}`.toLowerCase();

  // 各テナント固有に割り当てるオリジン（分類 (a)）。
  const ownMatched = new Map<string, string[]>(
    initialTenants.map((t) => [t, []]),
  );
  // 全テナント共通の dev オリジン（分類 (c)）。
  const sharedDevOrigins: string[] = [];

  for (const origin of allowedOrigins) {
    const host = parseOriginHost(origin);
    // host がパースできない、または baseDomain 配下のテナント形式でなければ (c)。
    if (host === undefined || !isBaseDomainTenantHost(host, suffix)) {
      sharedDevOrigins.push(origin);
      continue;
    }
    // baseDomain 配下のテナント形式サブドメイン。
    const tenantId = tenantByHost.get(host);
    if (tenantId === undefined) {
      // (b) 未登録テナント・表記揺れ。どの client にも追加しない（拒否）。
      continue;
    }
    // (a) 該当テナントの client にだけ割り当てる。
    ownMatched.get(tenantId)?.push(origin);
  }

  return initialTenants.map((tenantId) => {
    const own = `https://${tenantId}.${baseDomain}`;
    // 重複除去しつつ決定的な順序で:
    // 自サブドメイン → 自テナント一致オリジン → 共有 dev オリジン。
    const origins = Array.from(
      new Set([own, ...(ownMatched.get(tenantId) ?? []), ...sharedDevOrigins]),
    );
    return { tenantId, callbackOrigins: origins };
  });
}

/**
 * オリジン文字列を URL としてパースし host（小文字）を返す。パースできなければ
 * undefined。部分文字列一致による誤判定を避けるため URL コンストラクタを使う。
 */
function parseOriginHost(origin: string): string | undefined {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * host が baseDomain 配下の単一ラベルなテナント形式サブドメイン（{label}.{baseDomain}）
 * かどうかを判定する。suffix は '.{baseDomain}'（小文字）。
 */
function isBaseDomainTenantHost(host: string, suffix: string): boolean {
  if (!host.endsWith(suffix)) {
    return false;
  }
  const label = host.slice(0, host.length - suffix.length);
  // 単一ラベルのみテナント形式とみなす（さらにネストしたサブドメインは対象外）。
  return label.length > 0 && !label.includes('.');
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

/**
 * context の真偽値。`-c key=false` は文字列 'false' で渡るため文字列も受ける。
 * 解釈できない値は undefined（呼び出し側の既定値にフォールバック）。
 */
function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}
