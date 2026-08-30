import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsInt,
  Min,
  IsDateString,
  ValidateNested,
  IsOptional,
  IsNumber,
  Length,
  MaxLength,
  IsDefined,
  IsObject,
  IsUppercase,
} from 'class-validator';
import { Type } from 'class-transformer';

const ALLOWED_EVENT_TYPES = [
  'payment.pending',
  'payment.authorized',
  'payment.captured',
  'payment.refunded',
  'payment.failed',
] as const;

export class PaymentWebhookDataDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  @IsUppercase()
  currency?: string;
}

export class PaymentWebhookDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  event_id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  order_id: string;

  @IsIn(ALLOWED_EVENT_TYPES)
  event_type: string;

  @IsInt()
  @Min(0)
  sequence: number;

  @IsDateString()
  occurred_at: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PaymentWebhookDataDto)
  data: PaymentWebhookDataDto;
}
