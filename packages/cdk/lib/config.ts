/**
 * BackendApiStack の設定。既存リソースの参照や環境依存値は
 * cdk.json の context か、デプロイ時の -c で渡す。
 */
export interface BackendApiConfig {
  /** テナントサブドメインのベースドメイン（例: chelky.click） */
  readonly baseDomain: string;
  /**
   * 既存のワイルドカード ACM 証明書 ARN（*.chelky.click）。
   * us-east-1 に存在する前提。CloudFront に適用する。
   */
  readonly certificateArn: string;
  /** Route 53 ホストゾーンID（テナントCNAME作成に使用） */
  readonly hostedZoneId: string;
  /** フェーズ1で用意する pooled テナントのサブドメイン一覧（例: ["app"]） */
  readonly initialTenants: readonly string[];
  /** Lambda テナント分離モードを有効化するか（Premium相当） */
  readonly enableTenantIsolation: boolean;
}

const DEFAULTS = {
  baseDomain: 'chelky.click',
  initialTenants: ['app'],
  enableTenantIsolation: false,
} as const;

/**
 * cdk context から設定を読み出す。必須値が無ければ即エラー。
 */
export function resolveConfig(getContext: (key: string) => unknown): BackendApiConfig {
  const certificateArn = getContext('certificateArn');
  const hostedZoneId = getContext('hostedZoneId');

  if (typeof certificateArn !== 'string' || certificateArn.length === 0) {
    throw new Error(
      "context 'certificateArn' is required (existing *.chelky.click cert ARN in us-east-1)",
    );
  }
  if (typeof hostedZoneId !== 'string' || hostedZoneId.length === 0) {
    throw new Error("context 'hostedZoneId' is required (Route 53 hosted zone id)");
  }

  const baseDomain = asString(getContext('baseDomain')) ?? DEFAULTS.baseDomain;
  const initialTenants = asStringArray(getContext('initialTenants')) ?? [...DEFAULTS.initialTenants];
  const enableTenantIsolation =
    asBoolean(getContext('enableTenantIsolation')) ?? DEFAULTS.enableTenantIsolation;

  return { baseDomain, certificateArn, hostedZoneId, initialTenants, enableTenantIsolation };
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

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
