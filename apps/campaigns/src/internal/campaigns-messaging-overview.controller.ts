import {
	CampaignsApiGuard,
	CampaignsMessagingInternalGuard
} from '../auth/campaigns-auth.guard';
import { CampaignsMessagingOverviewService } from '../messaging/campaigns-messaging-overview.service';
import {
	Controller,
	Get,
	Header,
	HttpCode,
	UseGuards
} from '@nestjs/common';

@Controller('internal/v1/campaigns/messaging')
@UseGuards(CampaignsApiGuard, CampaignsMessagingInternalGuard)
export class CampaignsMessagingOverviewController {
	constructor(
		private readonly overview: CampaignsMessagingOverviewService
	) {}

	@Get('overview')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	getOverview() {
		return this.overview.getOverview();
	}
}
