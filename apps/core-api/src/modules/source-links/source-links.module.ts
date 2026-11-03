import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { SourceLinksController } from './source-links.controller.js';
import { SourceLinksRepository } from './source-links.repository.js';
import { SourceLinksService } from './source-links.service.js';

@Module({ imports: [PrismaModule], controllers: [SourceLinksController], providers: [SourceLinksRepository, SourceLinksService] })
export class SourceLinksModule {}
