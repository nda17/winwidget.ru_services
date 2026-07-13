import { CalculatorService } from '@/calculator/calculator.service';
import { SubmitCalculatorLeadDto } from '@/calculator/dto/submit-calculator-lead.dto';
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

const extractIp = (req: Request): string => {
	const forwarded = req.headers['x-forwarded-for'];
	if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
	return req.ip || req.socket?.remoteAddress || '';
};

@Controller('calculator')
export class CalculatorApiController {
	constructor(private readonly calculatorService: CalculatorService) {}

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
		const config = await this.calculatorService.getPublicConfig(
			key,
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-calculator', key)
		);

		if (config === null) {
			throw new NotFoundException('Калькулятор не найден');
		}

		return config;
	}

	@Post(':key/lead')
	@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
	async submitLead(
		@Param('key') key: string,
		@Body() dto: SubmitCalculatorLeadDto,
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		return this.calculatorService.submitLead(
			key,
			dto,
			extractIp(req),
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-calculator', key)
		);
	}
}
