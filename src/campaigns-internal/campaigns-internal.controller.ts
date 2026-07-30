import {
	Body,
	Controller,
	Headers,
	HttpCode,
	Post,
	Req,
	Res,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
	CAMPAIGNS_AUDIENCE_EXPORT_CONTENT_TYPE,
	CAMPAIGNS_AUDIENCE_EXPORT_PATH,
	CAMPAIGNS_AUTH_INTROSPECTION_PATH
} from './campaigns-internal.constants';
import { CampaignsAudienceExportDto } from './campaigns-internal.dto';
import { CampaignsAudienceExportService } from './campaigns-audience-export.service';
import { CampaignsAuthIntrospectionService } from './campaigns-auth-introspection.service';
import { CampaignsInternalTokenGuard } from './campaigns-internal-token.guard';

@Controller()
@UseGuards(CampaignsInternalTokenGuard)
export class CampaignsInternalController {
	constructor(
		private readonly authIntrospection: CampaignsAuthIntrospectionService,
		private readonly audienceExport: CampaignsAudienceExportService
	) {}

	@Post(CAMPAIGNS_AUTH_INTROSPECTION_PATH)
	@HttpCode(200)
	introspect(@Headers('authorization') authorization?: string) {
		return this.authIntrospection.introspect(authorization);
	}

	@Post(CAMPAIGNS_AUDIENCE_EXPORT_PATH)
	@HttpCode(200)
	@UsePipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		})
	)
	async exportAudience(
		@Body() dto: CampaignsAudienceExportDto,
		@Req() request: Request,
		@Res() response: Response
	): Promise<void> {
		response.status(200);
		response.setHeader(
			'Content-Type',
			`${CAMPAIGNS_AUDIENCE_EXPORT_CONTENT_TYPE}; charset=utf-8`
		);
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Accel-Buffering', 'no');

		try {
			await this.audienceExport.stream(dto, request, response);
			response.end();
		} catch (error) {
			if (!response.headersSent) throw error;
			response.destroy(
				error instanceof Error
					? error
					: new Error('Campaigns audience export failed')
			);
		}
	}
}
