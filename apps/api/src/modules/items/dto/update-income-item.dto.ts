import { PartialType } from '@nestjs/mapped-types';
import { CreateIncomeItemDto } from './create-income-item.dto.js';

export class UpdateIncomeItemDto extends PartialType(CreateIncomeItemDto) {}
