import { Type } from 'class-transformer';
import {
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	Max,
	MaxLength,
	Min,
	MinLength
} from 'class-validator';
import {
	CampaignAudience,
	CampaignDeliveryStatus,
	CampaignRequestedChannel,
	CampaignStatus
} from '@prisma/campaigns-client';

export class CreateCampaignDto {
	@IsString()
	@MinLength(3)
	@MaxLength(120)
	subject!: string;

	@IsString()
	@MinLength(10)
	@MaxLength(5000)
	message!: string;

	@IsEnum(CampaignAudience)
	audience!: CampaignAudience;

	@IsEnum(CampaignRequestedChannel)
	channel!: CampaignRequestedChannel;
}

export class CampaignsPageQueryDto {
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page = 1;

	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	@IsOptional()
	limit = 20;

	@IsEnum(CampaignStatus)
	@IsOptional()
	status?: CampaignStatus;
}

export class CampaignDeliveriesPageQueryDto {
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page = 1;

	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	@IsOptional()
	limit = 20;

	@IsEnum(CampaignDeliveryStatus)
	@IsOptional()
	status?: CampaignDeliveryStatus;
}
