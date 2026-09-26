// CloudFront Function (JavaScript runtime 2.0)
// /tenant-config.json へのリクエストに対し、Host からテナントを解決して
// そのテナント分の公開設定（App Client ID など）を JSON で「動的生成」して返す。
// オリジン(S3/Lambda)には行かず、この Function が viewer-request で早期レスポンスする。
//
// 目的: フロント(SPA)はビルド時に clientId を焼き込めない（単一 dist を全テナントへ
// 配信するため）。起動時にこのエンドポイントを叩き、今アクセスしているホストに
// 対応する clientId を実行時に取得する。
//
// 列挙対策: Host は CloudFront が受け取る正の値（マルチテナントディストリビューションは
// テナントごとに配信されるため偽装できない）。ここで返すのは Host に対応する1テナント分
// のみで、全テナントのマップは決して返さない。
//
// clientId は秘密ではない（public client は client secret を持たない）ため、
// baseDomain と同じくデプロイ時にコードへ焼き込む。CDK(edge.ts)が
// baseDomain とテナントマップのプレースホルダを置換注入する。
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value : '';
  var baseDomain = '__BASE_DOMAIN__';
  // { "tenant-a": { "userPoolId": "...", "userPoolClientId": "...", "hostedUiDomain": "..." }, ... }
  var tenantConfig = __TENANT_CLIENT_MAP__;
  var suffix = '.' + baseDomain;
  var tenant = '';
  var label = '';
  var cfg = null;
  var body = '';

  if (host.length > suffix.length && host.slice(-suffix.length) === suffix) {
    label = host.slice(0, host.length - suffix.length);
    // 単一ラベルのみ許可（さらにネストしたサブドメインは弾く）
    if (label.length > 0 && label.indexOf('.') === -1) {
      tenant = label;
    }
  }

  cfg = tenant && tenantConfig[tenant] ? tenantConfig[tenant] : null;

  if (!cfg) {
    return {
      statusCode: 404,
      statusDescription: 'Not Found',
      headers: {
        'content-type': { value: 'application/json' },
        'cache-control': { value: 'no-store' },
      },
      body: '{"message":"Unknown tenant"}',
    };
  }

  // 返すのは「このテナント1件」の公開設定のみ。
  body = JSON.stringify({
    tenantId: tenant,
    userPoolId: cfg.userPoolId,
    userPoolClientId: cfg.userPoolClientId,
    hostedUiDomain: cfg.hostedUiDomain,
  });

  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: {
      'content-type': { value: 'application/json' },
      // ホスト（テナント）ごとに内容が変わる。誤って別テナントへ配られないよう
      // キャッシュさせない。
      'cache-control': { value: 'no-store' },
    },
    body: body,
  };
}
