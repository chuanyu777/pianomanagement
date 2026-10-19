import 'dotenv/config';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../app.module.js';

function ensureExportOnlyConfig(): void {
  if (!process.env['CAPABILITY_SIGNING_PRIVATE_KEY_B64']) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env['CAPABILITY_SIGNING_PRIVATE_KEY_B64'] = Buffer.from(pem).toString('base64');
  }
  process.env['AGENT_RUNTIME_URL'] ||= 'http://127.0.0.1:3100';
  process.env['AGENT_DATABASE_URL'] ||= 'postgresql://127.0.0.1:5434/piano_agent';
  process.env['INTERNAL_SERVICE_SECRET'] ||= 'openapi-export-only-not-a-runtime-secret';
  process.env['JWT_SIGNING_SECRET'] ||= 'openapi-export-only-jwt-secret-012345678901234567890';
  process.env['AGENT_REQUEST_TIMEOUT_MS'] ||= '15000';
  process.env['AGENT_STREAM_IDLE_TIMEOUT_MS'] ||= '30000';
}

ensureExportOnlyConfig();
const app = await NestFactory.create(AppModule, { logger: false });
app.setGlobalPrefix('api');

try {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Piano Core API').setVersion('1.0').build(),
  );
  const output = new URL('../../openapi.json', import.meta.url);
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
} finally {
  await app.close();
}
