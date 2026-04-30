import { WidgetService } from '@/widget/widget.service';
import { getWidgetRequestDomain } from '@/widget-domain/widget-domain.util';
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

@Controller('widget')
export class WidgetApiController {
	constructor(private readonly widgetService: WidgetService) {}

	/**
	 * GET /api/widget/:key/config
	 * Returns widget config in drum-widget.js mapServerConfig format.
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
			extractIp(req),
			getWidgetRequestDomain(req)
		);
		if (config === null) {
			throw new NotFoundException('Виджет не найден');
		}
		return config;
	}

	/**
	 * POST /api/widget/:key/lead
	 * Accepts lead from drum-widget.js: { phone, email, name, bonus }
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
			extractIp(req),
			getWidgetRequestDomain(req)
		);
	}
}
