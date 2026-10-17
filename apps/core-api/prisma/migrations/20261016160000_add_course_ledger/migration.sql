-- CreateEnum
CREATE TYPE "PaymentChannel" AS ENUM ('CASH', 'WECHAT', 'ALIPAY', 'BANK_CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "LedgerEntryKind" AS ENUM ('PAYMENT', 'GIFT', 'PAYMENT_REVERSAL', 'GIFT_REVERSAL', 'LESSON_CONSUMPTION', 'LESSON_CONSUMPTION_REVERSAL', 'REFUND_PAID', 'REFUND_GIFT_CLEARING');

-- AlterTable
ALTER TABLE "StudentCourseAccount" ADD COLUMN     "openingGiftBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "openingPaidBalance" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AddCheckConstraint
ALTER TABLE "StudentCourseAccount" ADD CONSTRAINT "StudentCourseAccount_openingPaidBalance_nonnegative_check" CHECK ("openingPaidBalance" >= 0);

-- AddCheckConstraint
ALTER TABLE "StudentCourseAccount" ADD CONSTRAINT "StudentCourseAccount_openingGiftBalance_nonnegative_check" CHECK ("openingGiftBalance" >= 0);

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "channel" "PaymentChannel" NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_amount_positive_check" CHECK ("amount" > 0);

-- AddCheckConstraint
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_other_channel_note_check" CHECK ("channel" <> 'OTHER' OR btrim(COALESCE("note", '')) <> '');

-- CreateTable
CREATE TABLE "GiftRecord" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftRecord_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint
ALTER TABLE "GiftRecord" ADD CONSTRAINT "GiftRecord_amount_positive_check" CHECK ("amount" > 0);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "LedgerEntryKind" NOT NULL,
    "paidDelta" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "giftDelta" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "paymentId" TEXT,
    "giftId" TEXT,
    "reversesEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_nonzero_delta_check" CHECK ("paidDelta" <> 0 OR "giftDelta" <> 0);

-- CreateIndex
CREATE INDEX "PaymentRecord_accountId_occurredAt_idx" ON "PaymentRecord"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "GiftRecord_accountId_occurredAt_idx" ON "GiftRecord"("accountId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_commandId_key" ON "LedgerEntry"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_paymentId_key" ON "LedgerEntry"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_giftId_key" ON "LedgerEntry"("giftId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_reversesEntryId_key" ON "LedgerEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_occurredAt_id_idx" ON "LedgerEntry"("accountId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "LedgerEntry_createdById_createdAt_idx" ON "LedgerEntry"("createdById", "createdAt");

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StudentCourseAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftRecord" ADD CONSTRAINT "GiftRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StudentCourseAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftRecord" ADD CONSTRAINT "GiftRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StudentCourseAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "GiftRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
