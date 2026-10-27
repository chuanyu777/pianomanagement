// Explicit test-only loopback proxy. It never creates business results or changes Core.
// Start after the batch reset runner has finished; open http://localhost:5181.
import http from 'node:http';

let mode = 'pass';
let dropped = false;
let confirmations = 0;
let forwardedConfirmations = 0;
let previewReads = 0;
let lastUpstreamStatus = null;
const server = http.createServer((request, response) => {
  if (request.url === '/__ai_audit_fault') {
    if (request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        let input;
        try { input = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
        if (!['pass', 'drop-after-commit', 'unknown-after-commit', 'reject-before-forward'].includes(input.mode)) {
          response.writeHead(400).end(); return;
        }
        mode = input.mode; dropped = false; confirmations = 0; forwardedConfirmations = 0; previewReads = 0; lastUpstreamStatus = null;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode }));
      });
    } else {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode, dropped, confirmations, forwardedConfirmations, previewReads, lastUpstreamStatus }));
    }
    return;
  }
  const confirming = request.method === 'POST' && /^\/api\/assistant\/previews\/[^/]+\/confirm$/.test(request.url);
  const reading = request.method === 'GET' && /^\/api\/assistant\/previews\/[^/]+$/.test(request.url);
  if (reading) previewReads++;
  if (reading && mode === 'unknown-after-commit' && dropped) {
    response.writeHead(503, { 'content-type': 'application/json' }).end('{"message":"Test network unavailable"}'); return;
  }
  if (confirming) confirmations++;
  // Browsers can retry a dropped transport POST themselves. Block that retry so
  // the application must recover through GET rather than a second POST response.
  if (confirming && dropped && ['drop-after-commit', 'unknown-after-commit'].includes(mode)) {
    response.writeHead(503, { 'content-type': 'application/json' }).end('{"message":"Test confirmation response unavailable"}'); return;
  }
  if (confirming && mode === 'reject-before-forward') {
    response.writeHead(503, { 'content-type': 'application/json' }).end('{"message":"Test request not forwarded"}'); return;
  }
  const shouldDrop = confirming && !dropped && ['drop-after-commit', 'unknown-after-commit'].includes(mode);
  if (confirming) forwardedConfirmations++;
  const upstream = http.request({ hostname: '127.0.0.1', port: 5180, path: request.url, method: request.method,
    headers: { ...request.headers, host: 'localhost:5180' } }, result => {
    if (shouldDrop) {
      lastUpstreamStatus = result.statusCode;
      result.resume();
      result.on('end', () => { dropped = true; response.destroy(); });
    } else {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    }
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(upstream);
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
});
server.listen(5181, '127.0.0.1', () => console.log('AI audit fault proxy listening on loopback port 5181'));
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
