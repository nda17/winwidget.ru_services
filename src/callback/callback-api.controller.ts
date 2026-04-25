import { CallbackService } from '@/callback/callback.service';
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

@Controller('callback')
export class CallbackApiController {
	constructor(private readonly callbackService: CallbackService) {}

	@Get(':key/config')
	async getConfig(
		@Param('key') key: string,
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		const config = await this.callbackService.getPublicConfig(
			key,
			extractIp(req)
		);
		if (config === null) throw new NotFoundException('Виджет не найден');
		return config;
	}

	@Post(':key/lead')
	async submitLead(
		@Param('key') key: string,
		@Body()
		body: {
			phone?: string;
			timeSlot?: string;
			timezone?: string;
			url?: string;
		},
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		return this.callbackService.submitLead(
			{
				key,
				phone: body.phone || '',
				timeSlot: body.timeSlot,
				timezone: body.timezone,
				url: body.url
			},
			extractIp(req)
		);
	}
}
