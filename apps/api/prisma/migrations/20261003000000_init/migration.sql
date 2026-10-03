-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'TEACHER');

-- CreateEnum
CREATE TYPE "TeacherStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ENROLLED', 'PAUSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "LessonStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'CANCELLED', 'LEAVE');

-- CreateEnum
CREATE TYPE "ConsumptionOrder" AS ENUM ('GIFT_FIRST', 'PAID_FIRST');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('PAYMENT', 'GIFT', 'GIFT_REVOKE', 'CONSUMPTION', 'CONSUMPTION_REVERSAL', 'REFUND');

-- CreateEnum
CREATE TYPE "AutoSource" AS ENUM ('LESSON_CONSUMPTION', 'PAYMENT', 'REFUND_FEE', 'REFUND_PAID', 'PAYROLL_ACCRUED', 'PAYROLL_CASH', 'GIFT_COST', 'PROFIT_SHARE');

-- CreateEnum
CREATE TYPE "RefundMode" AS ENUM ('REFUND', 'KEEP');

-- CreateEnum
CREATE TYPE "PayrollSide" AS ENUM ('INCOME', 'EXPENSE');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "reporter" TEXT,
    "defaultCommissionRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "refundFeeRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "giftCountsAsBalance" BOOLEAN NOT NULL DEFAULT true,
    "consumptionOrder" "ConsumptionOrder" NOT NULL DEFAULT 'GIFT_FIRST',
    "initialCashBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "previousMonthProfit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "previousMonthPayroll" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "onboardingCompletedAt" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profit_share_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ratio" DECIMAL(6,4) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profit_share_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "teacher_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teachers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "hired_at" TIMESTAMP(3),
    "status" "TeacherStatus" NOT NULL DEFAULT 'ACTIVE',
    "commission_rate" DECIMAL(6,4),
    "default_base_salary" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teachers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grade_level" INTEGER NOT NULL,
    "status" "StudentStatus" NOT NULL DEFAULT 'ENROLLED',
    "wants_refund" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "teacher_id" TEXT NOT NULL,
    "course_type_id" TEXT NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "initial_paid_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "initial_gift_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "income_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "auto_source" "AutoSource",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "income_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "auto_source" "AutoSource",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deduction_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deduction_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lessons" (
    "id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "teacher_id" TEXT NOT NULL,
    "course_type_id" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "is_gift" BOOLEAN NOT NULL DEFAULT false,
    "gift_grant_id" TEXT,
    "status" "LessonStatus" NOT NULL DEFAULT 'SCHEDULED',
    "unit_price_snapshot" DECIMAL(14,2),
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "paid_delta" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gift_delta" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "income_item_id" TEXT,
    "lesson_id" TEXT,
    "gift_grant_id" TEXT,
    "refund_record_id" TEXT,
    "reverses_entry_id" TEXT,
    "note" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_grants" (
    "id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "lessons" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "activity_name" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL,
    "granted_by_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_records" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "mode" "RefundMode" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "paid_total" DECIMAL(14,2) NOT NULL,
    "gift_total" DECIMAL(14,2) NOT NULL,
    "fee_rate" DECIMAL(6,4) NOT NULL,
    "fee_amount" DECIMAL(14,2) NOT NULL,
    "refund_amount" DECIMAL(14,2) NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "other_expenses" (
    "id" TEXT NOT NULL,
    "expense_item_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "cash_amount" DECIMAL(14,2) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "other_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_incomes" (
    "id" TEXT NOT NULL,
    "income_item_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_incomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payrolls" (
    "id" TEXT NOT NULL,
    "teacher_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "attendance_expected" INTEGER NOT NULL DEFAULT 0,
    "attendance_actual" INTEGER NOT NULL DEFAULT 0,
    "attendance_absent" INTEGER NOT NULL DEFAULT 0,
    "base_salary" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "piano_bonus" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "recruit_bonus" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "commission_rate" DECIMAL(6,4),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payrolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_deductions" (
    "id" TEXT NOT NULL,
    "payroll_id" TEXT NOT NULL,
    "deduction_item_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closed_periods" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL,
    "closed_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closed_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_singleton_key" ON "organizations"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_teacher_id_idx" ON "users"("teacher_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_types_name_key" ON "course_types"("name");

-- CreateIndex
CREATE INDEX "students_status_idx" ON "students"("status");

-- CreateIndex
CREATE INDEX "enrollments_student_id_idx" ON "enrollments"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_student_id_teacher_id_course_type_id_key" ON "enrollments"("student_id", "teacher_id", "course_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "income_items_name_key" ON "income_items"("name");

-- CreateIndex
CREATE UNIQUE INDEX "expense_items_name_key" ON "expense_items"("name");

-- CreateIndex
CREATE UNIQUE INDEX "deduction_items_name_key" ON "deduction_items"("name");

-- CreateIndex
CREATE INDEX "lessons_teacher_id_scheduled_at_idx" ON "lessons"("teacher_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "lessons_student_id_scheduled_at_idx" ON "lessons"("student_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "lessons_status_idx" ON "lessons"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_reverses_entry_id_key" ON "ledger_entries"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "ledger_entries_enrollment_id_occurred_at_idx" ON "ledger_entries"("enrollment_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ledger_entries_occurred_at_idx" ON "ledger_entries"("occurred_at");

-- CreateIndex
CREATE INDEX "ledger_entries_kind_idx" ON "ledger_entries"("kind");

-- CreateIndex
CREATE INDEX "gift_grants_enrollment_id_granted_at_idx" ON "gift_grants"("enrollment_id", "granted_at");

-- CreateIndex
CREATE INDEX "gift_grants_activity_name_idx" ON "gift_grants"("activity_name");

-- CreateIndex
CREATE INDEX "refund_records_student_id_occurred_at_idx" ON "refund_records"("student_id", "occurred_at");

-- CreateIndex
CREATE INDEX "other_expenses_period_idx" ON "other_expenses"("period");

-- CreateIndex
CREATE INDEX "manual_incomes_period_idx" ON "manual_incomes"("period");

-- CreateIndex
CREATE INDEX "payrolls_period_idx" ON "payrolls"("period");

-- CreateIndex
CREATE UNIQUE INDEX "payrolls_teacher_id_period_key" ON "payrolls"("teacher_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_deductions_payroll_id_deduction_item_id_key" ON "payroll_deductions"("payroll_id", "deduction_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "closed_periods_period_key" ON "closed_periods"("period");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_course_type_id_fkey" FOREIGN KEY ("course_type_id") REFERENCES "course_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_course_type_id_fkey" FOREIGN KEY ("course_type_id") REFERENCES "course_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_gift_grant_id_fkey" FOREIGN KEY ("gift_grant_id") REFERENCES "gift_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_income_item_id_fkey" FOREIGN KEY ("income_item_id") REFERENCES "income_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_gift_grant_id_fkey" FOREIGN KEY ("gift_grant_id") REFERENCES "gift_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_refund_record_id_fkey" FOREIGN KEY ("refund_record_id") REFERENCES "refund_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_grants" ADD CONSTRAINT "gift_grants_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_records" ADD CONSTRAINT "refund_records_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_expenses" ADD CONSTRAINT "other_expenses_expense_item_id_fkey" FOREIGN KEY ("expense_item_id") REFERENCES "expense_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_incomes" ADD CONSTRAINT "manual_incomes_income_item_id_fkey" FOREIGN KEY ("income_item_id") REFERENCES "income_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_payroll_id_fkey" FOREIGN KEY ("payroll_id") REFERENCES "payrolls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_deduction_item_id_fkey" FOREIGN KEY ("deduction_item_id") REFERENCES "deduction_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

