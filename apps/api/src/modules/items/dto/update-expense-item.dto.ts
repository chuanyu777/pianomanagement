import { PartialType } from '@nestjs/mapped-types';
import { CreateExpenseItemDto } from './create-expense-item.dto.js';

export class UpdateExpenseItemDto extends PartialType(CreateExpenseItemDto) {}
