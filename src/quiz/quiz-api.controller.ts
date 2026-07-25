import { QuizService } from '@/quiz/quiz.service';
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

@Controller('quiz')
export class QuizApiController {
	constructor(private readonly quizService: QuizService) {}

	/**
	 * GET /api/v1/quiz/:key/config
	 * Returns quiz config for quiz.js
	 */
	@Get(':key/config')
	async getConfig(
		@Param('key') key: string,
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		const config = await this.quizService.getPublicConfig(
			key,
			extractIp(req),
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-quiz', key)
		);
		if (config === null) throw new NotFoundException('Квиз не найден');
		return config;
	}

	/**
	 * POST /api/v1/quiz/:key/lead
	 * Accepts lead from quiz.js: { contact, phone, email, answers, url }
	 */
	@Post(':key/lead')
	async submitLead(
		@Param('key') key: string,
		@Body()
		body: {
			contact?: string;
			phone?: string;
			email?: string;
			answers?: { questionId: string; optionIds: string[] }[];
			url?: string;
		},
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		const contact = body.phone || body.email || 'unknown';
		return this.quizService.submitLead(
			{
				key,
				contact,
				phone: body.phone,
				email: body.email,
				answers: body.answers || [],
				url: body.url
			},
			extractIp(req),
			getWidgetRequestDomain(req),
			isWidgetDirectPageRequest(req, 'page-quiz', key)
		);
	}
}
