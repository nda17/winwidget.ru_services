import {
	Body,
	Controller,
	Header,
	HttpCode,
	Post,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import {
	Equals,
	IsString,
	Matches,
	MaxLength,
	MinLength
} from 'class-validator';
import { BillingWincrmWidgetsGuard } from '../auth/billing-wincrm-widgets.guard';
import { WincrmWidgetsEligibilityService } from '../domain/wincrm-widgets-eligibility.service';

export class WincrmWidgetsEligibilityDto {
	@Equals(1) schemaVersion!: 1;
	@IsString()
	@MinLength(1)
	@MaxLength(256)
	@Matches(/^[^\s\x00-\x1f\x7f]+$/)
	ownerSubject!: string;
}

@Controller('internal/v1/billing/widgets')
@UseGuards(BillingWincrmWidgetsGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class BillingWincrmWidgetsController {
	constructor(
		private readonly eligibility: WincrmWidgetsEligibilityService
	) {}

	@Post('wincrm-eligibility')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	read(@Body() dto: WincrmWidgetsEligibilityDto) {
		return this.eligibility.read(dto.ownerSubject);
	}
}
