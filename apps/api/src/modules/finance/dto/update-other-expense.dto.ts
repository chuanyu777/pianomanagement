import { PartialType } from '@nestjs/mapped-types';
import { CreateOtherExpenseDto } from './create-other-expense.dto.js';

export class UpdateOtherExpenseDto extends PartialType(CreateOtherExpenseDto) {}
