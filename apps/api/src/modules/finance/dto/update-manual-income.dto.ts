import { PartialType } from '@nestjs/mapped-types';
import { CreateManualIncomeDto } from './create-manual-income.dto.js';

export class UpdateManualIncomeDto extends PartialType(CreateManualIncomeDto) {}
