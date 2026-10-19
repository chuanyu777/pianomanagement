-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('UNPAID', 'PAID');

-- CreateEnum
CREATE TYPE "ManualTransactionKind" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "ManualIncomeCategory" AS ENUM ('BOOK_SALE', 'INSTRUMENT_SALE', 'EXTERNAL_COOPERATION', 'OTHER_INCOME');

-- CreateEnum
CREATE TYPE "ManualExpenseCategory" AS ENUM ('RENT_PROPERTY', 'UTILITIES_NETWORK', 'MARKETING', 'OFFICE_SUPPLIES', 'MAINTENANCE', 'BOOK_PURCHASE_COST', 'INSTRUMENT_PURCHASE_COST', 'EXTERNAL_COOPERATION_COST', 'OTHER_EXPENSE');

-- AlterTable
ALTER TABLE "Teacher"
  ADD COLUMN "defaultBaseSalary" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "defaultCommissionRate" DECIMAL(7,4) NOT NULL DEFAULT 0;

ALTER TABLE "LedgerEntry" ADD COLUMN "refundDetailId" TEXT;

-- CreateTable
CREATE TABLE "RefundRecord" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "totalPaidRefund" DECIMAL(14,2) NOT NULL,
    "feeAmount" DECIMAL(14,2) NOT NULL,
    "feePercentage" DECIMAL(7,2) NOT NULL,
    "actualRefundAmount" DECIMAL(14,2) NOT NULL,
    "channel" "PaymentChannel" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundDetail" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "paidBalanceBefore" DECIMAL(14,2) NOT NULL,
    "giftBalanceBefore" DECIMAL(14,2) NOT NULL,
    "paidRefundAmount" DECIMAL(14,2) NOT NULL,
    "giftClearingAmount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "RefundDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payroll" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "courseRevenue" DECIMAL(14,2) NOT NULL,
    "baseSalary" DECIMAL(14,2) NOT NULL,
    "commissionRate" DECIMAL(7,4) NOT NULL,
    "commissionAmount" DECIMAL(14,2) NOT NULL,
    "bonusAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bonusNote" TEXT,
    "deductionAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deductionNote" TEXT,
    "grossSalary" DECIMAL(14,2) NOT NULL,
    "netSalary" DECIMAL(14,2) NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'UNPAID',
    "paidAt" TIMESTAMP(3),
    "paymentChannel" "PaymentChannel",
    "paymentNote" TEXT,
    "generatedById" TEXT NOT NULL,
    "paidById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payroll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualTransaction" (
    "id" TEXT NOT NULL,
    "kind" "ManualTransactionKind" NOT NULL,
    "incomeCategory" "ManualIncomeCategory",
    "expenseCategory" "ManualExpenseCategory",
    "amount" DECIMAL(14,2) NOT NULL,
    "channel" "PaymentChannel" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClosedPeriod" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT NOT NULL,
    "reopenedAt" TIMESTAMP(3),
    "reopenedById" TEXT,
    "reopenReason" TEXT,

    CONSTRAINT "ClosedPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefundRecord_studentId_key" ON "RefundRecord"("studentId");
CREATE INDEX "RefundRecord_occurredAt_idx" ON "RefundRecord"("occurredAt");
CREATE UNIQUE INDEX "RefundDetail_refundId_accountId_key" ON "RefundDetail"("refundId", "accountId");
CREATE INDEX "RefundDetail_accountId_idx" ON "RefundDetail"("accountId");
CREATE UNIQUE INDEX "Payroll_teacherId_periodStart_key" ON "Payroll"("teacherId", "periodStart");
CREATE INDEX "Payroll_periodStart_status_idx" ON "Payroll"("periodStart", "status");
CREATE INDEX "ManualTransaction_kind_occurredAt_idx" ON "ManualTransaction"("kind", "occurredAt");
CREATE UNIQUE INDEX "ClosedPeriod_periodStart_key" ON "ClosedPeriod"("periodStart");
CREATE INDEX "LedgerEntry_refundDetailId_idx" ON "LedgerEntry"("refundDetailId");

-- AddCheckConstraint
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_default_base_salary_nonnegative_check" CHECK ("defaultBaseSalary" >= 0);
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_default_commission_rate_nonnegative_check" CHECK ("defaultCommissionRate" >= 0);
ALTER TABLE "RefundRecord" ADD CONSTRAINT "RefundRecord_amounts_check" CHECK ("totalPaidRefund" >= 0 AND "feeAmount" >= 0 AND "feeAmount" <= "totalPaidRefund" AND "actualRefundAmount" = "totalPaidRefund" - "feeAmount");
ALTER TABLE "RefundRecord" ADD CONSTRAINT "RefundRecord_fee_percentage_nonnegative_check" CHECK ("feePercentage" >= 0);
ALTER TABLE "RefundRecord" ADD CONSTRAINT "RefundRecord_other_channel_note_check" CHECK ("channel" <> 'OTHER' OR btrim(COALESCE("note", '')) <> '');
ALTER TABLE "RefundDetail" ADD CONSTRAINT "RefundDetail_amounts_nonnegative_check" CHECK ("paidBalanceBefore" >= 0 AND "giftBalanceBefore" >= 0 AND "paidRefundAmount" >= 0 AND "giftClearingAmount" >= 0);
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_amounts_nonnegative_check" CHECK ("courseRevenue" >= 0 AND "baseSalary" >= 0 AND "commissionRate" >= 0 AND "commissionAmount" >= 0 AND "bonusAmount" >= 0 AND "deductionAmount" >= 0 AND "grossSalary" >= 0 AND "netSalary" >= 0);
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_calculation_check" CHECK ("grossSalary" = "baseSalary" + "commissionAmount" AND "netSalary" = "grossSalary" + "bonusAmount" - "deductionAmount");
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_bonus_note_check" CHECK ("bonusAmount" = 0 OR btrim(COALESCE("bonusNote", '')) <> '');
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_deduction_note_check" CHECK ("deductionAmount" = 0 OR btrim(COALESCE("deductionNote", '')) <> '');
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_payment_state_check" CHECK (("status" = 'UNPAID' AND "paidAt" IS NULL AND "paymentChannel" IS NULL AND "paidById" IS NULL) OR ("status" = 'PAID' AND "paidAt" IS NOT NULL AND "paymentChannel" IS NOT NULL AND "paidById" IS NOT NULL));
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_other_channel_note_check" CHECK ("paymentChannel" IS NULL OR "paymentChannel" <> 'OTHER' OR btrim(COALESCE("paymentNote", '')) <> '');
ALTER TABLE "ManualTransaction" ADD CONSTRAINT "ManualTransaction_amount_positive_check" CHECK ("amount" > 0);
ALTER TABLE "ManualTransaction" ADD CONSTRAINT "ManualTransaction_category_check" CHECK (("kind" = 'INCOME' AND "incomeCategory" IS NOT NULL AND "expenseCategory" IS NULL) OR ("kind" = 'EXPENSE' AND "incomeCategory" IS NULL AND "expenseCategory" IS NOT NULL));
ALTER TABLE "ManualTransaction" ADD CONSTRAINT "ManualTransaction_other_channel_note_check" CHECK ("channel" <> 'OTHER' OR btrim(COALESCE("note", '')) <> '');
ALTER TABLE "ClosedPeriod" ADD CONSTRAINT "ClosedPeriod_reopen_state_check" CHECK (("reopenedAt" IS NULL AND "reopenedById" IS NULL AND "reopenReason" IS NULL) OR ("reopenedAt" IS NOT NULL AND "reopenedById" IS NOT NULL AND btrim(COALESCE("reopenReason", '')) <> ''));

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_refundDetailId_fkey" FOREIGN KEY ("refundDetailId") REFERENCES "RefundDetail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundRecord" ADD CONSTRAINT "RefundRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundRecord" ADD CONSTRAINT "RefundRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundDetail" ADD CONSTRAINT "RefundDetail_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "RefundRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundDetail" ADD CONSTRAINT "RefundDetail_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StudentCourseAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualTransaction" ADD CONSTRAINT "ManualTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClosedPeriod" ADD CONSTRAINT "ClosedPeriod_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClosedPeriod" ADD CONSTRAINT "ClosedPeriod_reopenedById_fkey" FOREIGN KEY ("reopenedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
