import { PartialType } from '@nestjs/mapped-types';
import { CreateDeductionItemDto } from './create-deduction-item.dto.js';

export class UpdateDeductionItemDto extends PartialType(CreateDeductionItemDto) {}
