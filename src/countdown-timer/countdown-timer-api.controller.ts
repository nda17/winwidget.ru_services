import { CountdownTimerService } from '@/countdown-timer/countdown-timer.service';
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

@Controller('countdown-timer')
export class CountdownTimerApiController {
	constructor(
		private readonly countdownTimerService: CountdownTimerService
	) {}

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
		const config = await this.countdownTimerService.getPublicConfig(
			key,
			extractIp(req),
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-timer', key)
		);
		if (config === null) throw new NotFoundException('Таймер не найден');
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
		return this.countdownTimerService.submitLead(
			{
				key,
				phone: body.phone,
				email: body.email,
				url: body.url
			},
			extractIp(req),
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-timer', key)
		);
	}
}
