// CloudFront Function (JavaScript runtime 2.0)
// Host ヘッダーから {tenant}.<baseDomain> のサブドメインを取り出し、
// X-Tenant-Id リクエストヘッダーとしてオリジンへ渡す。認証前・JWT非検証。
// 正のテナントIDは Lambda Authorizer が JWT から取得して突合する。
//
// baseDomain は CDK(edge.ts)がデプロイ時に __BASE_DOMAIN__ を config.baseDomain で
// 置換して注入する。CloudFront Function は実行時に環境変数を持てないため、
// 設定の単一ソース(config.baseDomain)をコードへ焼き込む。
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value : '';
  var baseDomain = '__BASE_DOMAIN__';

  var suffix = '.' + baseDomain;
  if (host.length > suffix.length && host.slice(-suffix.length) === suffix) {
    var tenant = host.slice(0, host.length - suffix.length);
    // 単一ラベルのみ許可（さらにネストしたサブドメインは弾く）
    if (tenant.length > 0 && tenant.indexOf('.') === -1) {
      request.headers['x-tenant-id'] = { value: tenant };
    }
  }

  return request;
}
