// CloudFront Function (JavaScript runtime 2.0)
// SPA のクライアントサイドルーティング用フォールバック（viewer-request）。
// ディープリンク（例 /dashboard）は S3 に該当オブジェクトが無く 403/404 になるため、
// URI を /index.html に書き換えて SPA のエントリを返し、ルーティングをクライアントに委ねる。
// 拡張子を持つ静的アセット（例 /assets/app.abcd.js、/favicon.ico）はそのまま通し、
// 実在アセットの配信と欠損アセットの正当な 404 を保つ。
// この Function は SPA(S3) の default behavior にのみ関連付け、/api/* には付与しない。
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // URI の最後の '/' 区切りセグメントを取り出す。
  var lastSlash = uri.lastIndexOf('/');
  var lastSegment = lastSlash === -1 ? uri : uri.slice(lastSlash + 1);

  // 最後のセグメントに '.'（拡張子）が含まれなければクライアントルートとみなし、
  // SPA のエントリへ書き換える。
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }

  return request;
}
