import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { BusinessReasonFilter } from './common/errors/business-reason.filter.js';
import { parseCoreConfig } from './config/core-config.js';

async function bootstrap(): Promise<void> {
  const config = parseCoreConfig(process.env);
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new BusinessReasonFilter());
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Piano Core API').setVersion('1.0').build(),
  );
  SwaggerModule.setup('api/docs', app, document);
  await app.listen(config.CORE_PORT);
}

await bootstrap();
