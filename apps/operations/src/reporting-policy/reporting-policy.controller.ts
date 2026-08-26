import {
	Body,
	Controller,
	HttpCode,
	Post,
	Put,
	UseGuards
} from '@nestjs/common';
import { ReportingPolicyGuard } from './reporting-policy.guard';
import { ReportingPolicyService } from './reporting-policy.service';

@Controller('internal/v1/operations/reporting/schedule-policy')
@UseGuards(ReportingPolicyGuard)
export class ReportingPolicyController {
	constructor(private readonly policy: ReportingPolicyService) {}

	@Put()
	@HttpCode(200)
	reserve(@Body() body: unknown) {
		return this.policy.reserve(body);
	}

	@Post('confirm')
	@HttpCode(200)
	confirm(@Body() body: unknown) {
		return this.policy.confirm(body);
	}
}
