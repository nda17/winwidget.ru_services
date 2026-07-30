import {
	Controller,
	Get,
	Headers,
	HttpCode,
	HttpStatus,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Req,
	UseGuards,
	Body
} from '@nestjs/common';
import {
	CampaignDeliveriesPageQueryDto,
	CampaignsPageQueryDto,
	CreateCampaignDto
} from './campaigns.dto';
import { CampaignsService } from './campaigns.service';
import { CampaignsRole } from '../auth/campaigns-auth.decorator';
import {
	CampaignsApiGuard,
	CampaignsAuthGuard
} from '../auth/campaigns-auth.guard';
import type { CampaignsRequest } from '../auth/campaigns-request';

@Controller('/api/v1/admin/campaigns')
@UseGuards(CampaignsApiGuard, CampaignsAuthGuard)
export class CampaignsController {
	constructor(private readonly campaigns: CampaignsService) {}

	@Post()
	@HttpCode(HttpStatus.ACCEPTED)
	@CampaignsRole('ADMIN')
	create(
		@Req() request: CampaignsRequest,
		@Headers('idempotency-key') idempotencyKey: string | undefined,
		@Body() dto: CreateCampaignDto
	) {
		return this.campaigns.create(
			request.campaignsActor.subject,
			idempotencyKey,
			dto
		);
	}

	@Get()
	@CampaignsRole('ADMIN')
	list(@Query() query: CampaignsPageQueryDto) {
		return this.campaigns.list(query);
	}

	@Get('/:id')
	@CampaignsRole('ADMIN')
	get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
		return this.campaigns.get(id);
	}

	@Post('/:id/cancel')
	@HttpCode(HttpStatus.ACCEPTED)
	@CampaignsRole('ADMIN')
	cancel(
		@Req() request: CampaignsRequest,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string
	) {
		return this.campaigns.cancel(id, request.campaignsActor.subject);
	}

	@Get('/:id/deliveries')
	@CampaignsRole('ADMIN')
	listDeliveries(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: CampaignDeliveriesPageQueryDto
	) {
		return this.campaigns.listDeliveries(id, query);
	}

	@Post('/:id/deliveries/:deliveryId/retry')
	@HttpCode(HttpStatus.ACCEPTED)
	@CampaignsRole('DEV')
	retryDelivery(
		@Req() request: CampaignsRequest,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Param('deliveryId', new ParseUUIDPipe({ version: '4' }))
		deliveryId: string,
		@Headers('idempotency-key') idempotencyKey: string | undefined
	) {
		return this.campaigns.retryDelivery(
			id,
			deliveryId,
			request.campaignsActor.subject,
			idempotencyKey
		);
	}
}
