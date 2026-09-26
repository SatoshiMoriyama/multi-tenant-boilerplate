// CloudFront Function (JavaScript runtime 2.0)
// SPA のクライアントサイドルーティング用フォールバック（viewer-request）。
// ディープリンク（例 /dashboard, /reports/2024.q1）は S3 に該当オブジェクトが無く
// 403/404 になるため、URI を /index.html に書き換えて SPA のエントリを返し、
// ルーティングをクライアントに委ねる。実在する静的アセット（例 /assets/app.abcd.js,
// /favicon.ico）はそのまま通し、配信と欠損アセットの正当な 404 を保つ。
//
// 判定ルール（1つに絞る）: 「既知の静的ファイル拡張子で終わる URI だけを静的アセット
// とみなし、それ以外はすべて /index.html へ書き換える」。最後のセグメントに '.' が
// あるかどうかではなく、末尾が本物の拡張子パターンかで判定するため、ドットを含む
// 拡張子なしのクライアントルート（例 /reports/2024.q1, /v1.2/overview）も
// 正しく SPA エントリへ振り分けられる。トレードオフ: 拡張子リストに無い形式の
// 実ファイル（稀）は index.html に書き換わりうるが、ハッシュ付きアセット構成の
// SPA では実害がなく、ディープリンクを取りこぼさない方を優先する。
//
// この Function は SPA(S3) の default behavior にのみ関連付ける。念のため（多層防御）
// /api/* は明示的に素通しし、API リクエストが書き換わらないことを二重に保証する。
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // /api/* は API 用ビヘイビアの領域。default behavior にしか付けていないが、
  // 多層防御として明示的にそのまま通す。
  if (uri.indexOf('/api/') === 0) {
    return request;
  }

  // 既知の静的ファイル拡張子で終わる URI だけを静的アセットとして素通しする。
  var staticAsset = /\.(?:js|mjs|cjs|css|map|html|htm|json|txt|xml|ico|png|jpg|jpeg|gif|svg|webp|avif|bmp|woff|woff2|ttf|otf|eot|wasm|pdf|mp4|webm|mp3|wav|ogg)$/i;
  if (staticAsset.test(uri)) {
    return request;
  }

  // それ以外（拡張子なしのルート、ドットを含むルート等）は SPA のエントリへ。
  request.uri = '/index.html';
  return request;
}
