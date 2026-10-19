import { Injectable } from '@nestjs/common';
import { type Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class RefundsRepository {
  constructor(private readonly prisma: PrismaService) {}

  get refundRecord(): PrismaService['refundRecord'] {
    return this.prisma.refundRecord;
  }

  transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(operation);
  }
}
