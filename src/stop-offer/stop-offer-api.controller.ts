import { StopOfferService } from '@/stop-offer/stop-offer.service';
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

function extractIp(req: Request): string {
	const forwarded = req.headers['x-forwarded-for'];
	if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
	return req.ip || req.socket?.remoteAddress || '';
}

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
			extractIp(req),
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
			extractIp(req),
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-stop-offer', key)
		);
	}
}
