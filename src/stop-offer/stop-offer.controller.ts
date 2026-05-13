import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CreateStopOfferDto } from '@/stop-offer/dto/create-stop-offer.dto';
import { UpdateStopOfferDto } from '@/stop-offer/dto/update-stop-offer.dto';
import { StopOfferService } from '@/stop-offer/stop-offer.service';
import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Query,
	Res
} from '@nestjs/common';
import { Response } from 'express';

@Auth()
@Controller('stop-offers')
export class StopOfferController {
	constructor(private readonly stopOfferService: StopOfferService) {}

	@Get()
	async getMyStopOffers(@CurrentUser('id') userId: string) {
		return this.stopOfferService.getMyStopOffers(userId);
	}

	@Post()
	async createStopOffer(
		@CurrentUser('id') userId: string,
		@Body() dto: CreateStopOfferDto
	) {
		return this.stopOfferService.createStopOffer(userId, dto);
	}

	@Patch(':id')
	async updateStopOffer(
		@CurrentUser('id') userId: string,
		@Param('id') stopOfferId: string,
		@Body() dto: UpdateStopOfferDto
	) {
		return this.stopOfferService.updateStopOffer(userId, stopOfferId, dto);
	}

	@Delete(':id')
	async deleteStopOffer(
		@CurrentUser('id') userId: string,
		@Param('id') stopOfferId: string
	) {
		return this.stopOfferService.deleteStopOffer(userId, stopOfferId);
	}

	@Get(':id/leads')
	async getLeads(
		@CurrentUser('id') userId: string,
		@Param('id') stopOfferId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.stopOfferService.getLeads(
			userId,
			stopOfferId,
			Number(page) || 1,
			Number(limit) || 50
		);
	}

	@Get(':id/leads/export')
	async exportLeads(
		@CurrentUser('id') userId: string,
		@Param('id') stopOfferId: string,
		@Query('format') format: 'csv' | 'xlsx' = 'csv',
		@Res() res: Response
	) {
		const result = await this.stopOfferService.exportLeads(
			userId,
			stopOfferId,
			format === 'xlsx' ? 'xlsx' : 'csv'
		);
		res.setHeader('Content-Type', result.contentType);
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="${encodeURIComponent(result.filename)}"`
		);
		return res.send(result.data);
	}
}
