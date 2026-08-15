import {
	ReportingApiGuard,
	ReportingMessagingInternalGuard
} from '../auth/reporting-auth.guard';
import { ReportingMessagingOverviewService } from '../messaging/reporting-messaging-overview.service';
import {
	Controller,
	Get,
	Header,
	HttpCode,
	UseGuards
} from '@nestjs/common';

@Controller('internal/v1/reporting/messaging')
@UseGuards(ReportingApiGuard, ReportingMessagingInternalGuard)
export class ReportingMessagingOverviewController {
	constructor(
		private readonly overview: ReportingMessagingOverviewService
	) {}

	@Get('overview')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	getOverview() {
		return this.overview.getOverview();
	}
}
