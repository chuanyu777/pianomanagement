-- CreateEnum
ALTER TYPE "LedgerEntryKind" ADD VALUE 'LESSON_CONSUMPTION_CORRECTION';

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN "correctsEntryId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_correctsEntryId_key" ON "LedgerEntry"("correctsEntryId");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_correctsEntryId_fkey"
  FOREIGN KEY ("correctsEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
