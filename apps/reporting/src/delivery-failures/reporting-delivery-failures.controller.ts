import {
	ReportingAdminGuard,
	ReportingApiGuard,
	RequireReportingRole
} from '../auth/reporting-auth.guard';
import type { ReportingRequest } from '../auth/reporting-request';
import { ReportingDeliveryFailuresService } from './reporting-delivery-failures.service';
import {
	Controller,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Req,
	UseGuards
} from '@nestjs/common';

@Controller('/api/v1/admin/reporting/delivery-failures')
@UseGuards(ReportingApiGuard, ReportingAdminGuard)
@RequireReportingRole('ADMIN')
export class ReportingDeliveryFailuresController {
	constructor(
		private readonly failures: ReportingDeliveryFailuresService
	) {}

	@Post('/:eventId/:consumerKind/retry')
	@HttpCode(202)
	@RequireReportingRole('DEV')
	retry(
		@Param('eventId', new ParseUUIDPipe()) eventId: string,
		@Param('consumerKind') consumerKind: string,
		@Req() request: ReportingRequest
	) {
		if (!request.reportingActor) {
			throw new Error('Reporting actor is missing after authorization');
		}
		return this.failures.retryFailure(
			eventId,
			consumerKind,
			request.reportingActor.subject
		);
	}
}
