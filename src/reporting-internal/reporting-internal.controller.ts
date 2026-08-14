import {
	Controller,
	Body,
	HttpCode,
	Post,
	Put,
	Req,
	Res,
	UseGuards
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
	REPORTING_SCHEDULE_POLICY_CONFIRM_PATH,
	REPORTING_SCHEDULE_POLICY_PATH
} from './reporting-internal.constants';
import { ReportingInternalTokenGuard } from './reporting-internal-token.guard';
import { ReportingSchedulePolicyService } from './reporting-schedule-authority.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller()
@UseGuards(ReportingInternalTokenGuard)
export class ReportingInternalController {
	constructor(
		private readonly schedulePolicy: ReportingSchedulePolicyService
	) {}

	@Put(REPORTING_SCHEDULE_POLICY_PATH)
	@HttpCode(200)
	reserveSchedule(
		@Body() body: unknown,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const correlationId = this.setCorrelationId(request, response);
		return this.schedulePolicy.reserve(body, correlationId);
	}

	@Post(REPORTING_SCHEDULE_POLICY_CONFIRM_PATH)
	@HttpCode(200)
	confirmSchedulePolicy(
		@Body() body: unknown,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const correlationId = this.setCorrelationId(request, response);
		return this.schedulePolicy.confirm(body, correlationId);
	}

	private setCorrelationId(request: Request, response: Response): string {
		const supplied = request.headers['x-correlation-id'];
		const correlationId =
			typeof supplied === 'string' && UUID_PATTERN.test(supplied)
				? supplied
				: randomUUID();
		response.setHeader('X-Correlation-ID', correlationId);
		return correlationId;
	}
}
