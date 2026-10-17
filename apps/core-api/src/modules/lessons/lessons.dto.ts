import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LessonStatus } from '../../generated/prisma/client.js';

export class CreateLessonBody {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', description: '店主必填；教师只能排自己的课程' })
  teacherId?: string;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;

  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  note?: string;
}

export class RescheduleLessonBody {
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;
}

export class CancelLessonBody {
  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  note?: string;
}

export class CompleteLessonBody {
  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  note?: string;
}

export class LessonResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  accountId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  teacherId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt!: Date;

  @ApiProperty({ enum: LessonStatus })
  status!: LessonStatus;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '200.00' })
  unitPriceSnapshot!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;

  @ApiProperty({ type: Object })
  student!: { id: string; name: string };

  @ApiProperty({ type: Object })
  course!: { id: string; name: string };
}
