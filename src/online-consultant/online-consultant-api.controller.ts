import { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
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

@Controller('online-consultant')
export class OnlineConsultantApiController {
	constructor(
		private readonly onlineConsultantService: OnlineConsultantService
	) {}

	@Get(':key/config')
	async getConfig(
		@Param('key') key: string,
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		const config = await this.onlineConsultantService.getPublicConfig(
			key,
			getClientIp(req) ?? '',
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-online-consultant', key)
		);
		if (config === null)
			throw new NotFoundException('Онлайн-консультант не найден');
		return config;
	}

	@Post(':key/lead')
	async submitLead(
		@Param('key') key: string,
		@Body()
		body: {
			phone?: string;
			email?: string;
			actionLabel?: string;
			actionValue?: string;
			url?: string;
		},
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		return this.onlineConsultantService.submitLead(
			{
				key,
				phone: body.phone,
				email: body.email,
				actionLabel: body.actionLabel,
				actionValue: body.actionValue,
				url: body.url
			},
			getClientIp(req) ?? '',
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-online-consultant', key)
		);
	}
}
