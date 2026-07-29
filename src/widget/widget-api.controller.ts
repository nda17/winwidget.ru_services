import { getClientIp } from '@/utils/ip.util';
import { WidgetService } from '@/widget/widget.service';
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

@Controller('widget')
export class WidgetApiController {
	constructor(private readonly widgetService: WidgetService) {}

	/**
	 * GET /api/v1/widget/:key/config
	 * Returns widget config in the wheel runtime format.
	 */
	@Get(':key/config')
	async getConfig(
		@Param('key') key: string,
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		const config = await this.widgetService.getPublicConfig(
			key,
			getClientIp(req) ?? '',
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-wheel', key)
		);
		if (config === null) {
			throw new NotFoundException('Виджет не найден');
		}
		return config;
	}

	/**
	 * POST /api/v1/widget/:key/lead
	 * Accepts lead from the public wheel widget:
	 * { phone, email, name, bonus, url }
	 */
	@Post(':key/lead')
	async submitLead(
		@Param('key') key: string,
		@Body()
		body: {
			phone?: string;
			email?: string;
			name?: string;
			bonus?: string;
			url?: string;
		},
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		return this.widgetService.submitLeadByKey(
			key,
			body.phone,
			body.email,
			body.name,
			body.bonus,
			getClientIp(req) ?? '',
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-wheel', key),
			body.url
		);
	}
}
