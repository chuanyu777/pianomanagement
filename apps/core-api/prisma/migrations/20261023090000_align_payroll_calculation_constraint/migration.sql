ALTER TABLE "Payroll"
  DROP CONSTRAINT "Payroll_calculation_check";

ALTER TABLE "Payroll"
  ADD CONSTRAINT "Payroll_calculation_check"
  CHECK (
    "grossSalary" = "baseSalary" + "commissionAmount" + "bonusAmount"
    AND "netSalary" = "grossSalary" - "deductionAmount"
  );
