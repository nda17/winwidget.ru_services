import {
	ArrayMaxSize,
	ArrayMinSize,
	ArrayUnique,
	IsIn,
	IsArray,
	IsInt,
	IsOptional,
	IsString,
	Max,
	MaxLength,
	Min,
	MinLength
} from 'class-validator';
import { Type } from 'class-transformer';

export class ResolveWidgetOwnersDto {
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(100)
	@ArrayUnique()
	@IsString({ each: true })
	@MinLength(1, { each: true })
	@MaxLength(255, { each: true })
	userIds!: string[];
}

export const WIDGET_OWNER_SEARCH_PLANS = [
	'TRIAL',
	'EASY',
	'HARD',
	'NONE'
] as const;

export type WidgetOwnerSearchPlan =
	(typeof WIDGET_OWNER_SEARCH_PLANS)[number];

export class SearchWidgetOwnersDto {
	@IsOptional()
	@IsString()
	@MaxLength(200)
	search?: string;

	@IsOptional()
	@IsIn(WIDGET_OWNER_SEARCH_PLANS)
	plan?: WidgetOwnerSearchPlan;

	@IsOptional()
	@IsString()
	@MinLength(1)
	@MaxLength(255)
	afterId?: string;

	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit!: number;
}
