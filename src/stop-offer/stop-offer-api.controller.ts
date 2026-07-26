import { StopOfferService } from '@/stop-offer/stop-offer.service';
import { getClientIp } from '@/utils/ip.util';
import {
	getWidgetRequestDomain,
	isWidgetDirectPageRequest
} from '@/widget-domain/widget-domain.util';
import {
	Body,
	Controller,
	Get,
	NotFoundException,
	Param,
	Post,
	Req,
	Res
} from '@nestjs/common';
import { Request, Response } from 'express';

@Controller('stop-offer')
export class StopOfferApiController {
	constructor(private readonly stopOfferService: StopOfferService) {}

	@Get(':key/config')
	async getConfig(
		@Param('key') key: string,
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader(
			'Cache-Control',
			'no-store, no-cache, must-revalidate, proxy-revalidate'
		);
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
		const config = await this.stopOfferService.getPublicConfig(
			key,
			getClientIp(req) ?? '',
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-stop-offer', key)
		);
		if (config === null)
			throw new NotFoundException('Стоп-оффер не найден');
		return config;
	}

	@Post(':key/lead')
	async submitLead(
		@Param('key') key: string,
		@Body() body: { phone?: string; email?: string; url?: string },
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		return this.stopOfferService.submitLead(
			{
				key,
				phone: body.phone,
				email: body.email,
				url: body.url
			},
			getClientIp(req) ?? '',
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-stop-offer', key)
		);
	}
}
