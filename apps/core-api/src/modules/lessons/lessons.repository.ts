import { Injectable } from '@nestjs/common';
import { type Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Thin persistence boundary for lesson use cases. */
@Injectable()
export class LessonsRepository {
  constructor(private readonly prisma: PrismaService) {}

  get lesson(): PrismaService['lesson'] {
    return this.prisma.lesson;
  }

  get studentCourseAccount(): PrismaService['studentCourseAccount'] {
    return this.prisma.studentCourseAccount;
  }

  get ledgerEntry(): PrismaService['ledgerEntry'] {
    return this.prisma.ledgerEntry;
  }

  transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(operation);
  }
}
