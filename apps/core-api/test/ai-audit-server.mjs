// Standalone test bootstrap; never imported by the production server.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { withBusinessTime } from '../dist/common/time/business-clock.js';

if (new URL(process.env.CORE_DATABASE_URL).pathname !== '/piano_core_ai_audit') throw new Error('ISOLATED_AUDIT_DATABASE_REQUIRED');
const fixed = new Date(process.env.AI_AUDIT_BUSINESS_NOW);
if (!Number.isFinite(fixed.getTime())) throw new Error('AUDIT_CLOCK_REQUIRED');
const app = await NestFactory.create(AppModule, { logger:['error','warn'] });
app.setGlobalPrefix('api');
let faultMode = 'pass';
app.use((request,_response,next) => {
  const auditFaultPath = request.url.split('?')[0];
  if (auditFaultPath === '/api/__audit/fault-mode') {
    const mode = new URL(`http://audit.local${request.url}`).searchParams.get('mode') ?? 'pass';
    if (!['pass', 'query-failure', 'core-write-failure', 'drop-after-commit', 'unknown-after-commit', 'reject-before-forward'].includes(mode)) {
      return _response.status(400).json({ message: 'invalid audit fault mode' });
    }
    faultMode = mode;
    return _response.json({ mode: faultMode });
  }
  const isInternalRead = request.method === 'GET' && request.url.startsWith('/api/internal/tools/');
  const isConfirm = request.method === 'POST' && /^\/api\/assistant\/previews\/[^/]+\/confirm(?:\?|$)/.test(request.url);
  if (faultMode === 'query-failure' && isInternalRead) return _response.status(503).json({ message: 'AUDIT_QUERY_FAILURE' });
  if (faultMode === 'core-write-failure' && isConfirm) return _response.status(503).json({ message: 'AUDIT_CORE_WRITE_FAILURE' });
  if (faultMode === 'reject-before-forward' && isConfirm) return _response.status(503).json({ message: 'AUDIT_REQUEST_NOT_SENT' });
  if (isConfirm && (faultMode === 'drop-after-commit' || faultMode === 'unknown-after-commit')) {
    const json = _response.json.bind(_response);
    _response.json = (body) => { _response.status(503); return json({ message: 'AUDIT_RESPONSE_LOST', committedResponse: body }); };
  }
  // Available only in this guarded standalone test server, never production.
  const requested=request.headers['x-ai-audit-business-now'];
  const current=typeof requested==='string'?new Date(requested):fixed;
  if(!Number.isFinite(current.getTime()))throw new Error('INVALID_AUDIT_BUSINESS_TIME');
  return withBusinessTime(current,next);
});
app.enableShutdownHooks();
await app.listen(3000,'0.0.0.0');
