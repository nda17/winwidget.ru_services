import {
	Controller,
	HttpCode,
	Post,
	Req,
	Res,
	UseGuards
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BillingCampaignsGuard } from '../auth/billing-campaigns.guard';
import { BillingCampaignAudienceService } from '../domain/billing-campaign-audience.service';

@Controller('internal/v1/billing/campaigns')
@UseGuards(BillingCampaignsGuard)
export class BillingCampaignAudienceController {
	constructor(private readonly audience: BillingCampaignAudienceService) {}

	@Post('active-subscriber-ids')
	@HttpCode(200)
	async stream(
		@Req() request: Request,
		@Res() response: Response
	): Promise<void> {
		response.status(200);
		response.setHeader(
			'Content-Type',
			'application/x-ndjson; charset=utf-8'
		);
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Accel-Buffering', 'no');
		try {
			await this.audience.stream(request, response);
			response.end();
		} catch (error) {
			if (!response.headersSent) throw error;
			response.destroy(
				error instanceof Error
					? error
					: new Error('Campaign subscriber export failed')
			);
		}
	}
}
