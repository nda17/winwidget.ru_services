import { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
import { SubmitOnlineConsultantLeadDto } from '@/online-consultant/dto/submit-online-consultant-lead.dto';
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
	Res,
	UsePipes,
	ValidationPipe
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
	@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
	async submitLead(
		@Param('key') key: string,
		@Body() dto: SubmitOnlineConsultantLeadDto,
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		return this.onlineConsultantService.submitLead(
			key,
			dto,
			getClientIp(req) ?? '',
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-online-consultant', key)
		);
	}
}
