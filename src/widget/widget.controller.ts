import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CreateWidgetDto } from '@/widget/dto/create-widget.dto';
import { SubmitLeadDto } from '@/widget/dto/submit-lead.dto';
import { UpdateWidgetDto } from '@/widget/dto/update-widget.dto';
import { WidgetService } from '@/widget/widget.service';
import { getWidgetRequestDomain } from '@/widget-domain/widget-domain.util';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Query,
	Req,
	Res,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Request, Response } from 'express';

@Controller('widgets')
export class WidgetController {
	constructor(private readonly widgetService: WidgetService) {}

	@HttpCode(200)
	@Auth()
	@Get()
	async getMyWidgets(@CurrentUser('id') userId: string) {
		return this.widgetService.getMyWidgets(userId);
	}

	@HttpCode(201)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post()
	async createWidget(
		@CurrentUser('id') userId: string,
		@Body() dto: CreateWidgetDto
	) {
		return this.widgetService.createWidget(userId, dto);
	}

	@HttpCode(200)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Patch(':id')
	async updateWidget(
		@CurrentUser('id') userId: string,
		@Param('id') widgetId: string,
		@Body() dto: UpdateWidgetDto
	) {
		return this.widgetService.updateWidget(userId, widgetId, dto);
	}

	@HttpCode(200)
	@Auth()
	@Delete(':id')
	async deleteWidget(
		@CurrentUser('id') userId: string,
		@Param('id') widgetId: string
	) {
		return this.widgetService.deleteWidget(userId, widgetId);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads/stats')
	async getLeadsStats(
		@CurrentUser('id') userId: string,
		@Param('id') widgetId: string
	) {
		return this.widgetService.getLeadsStats(userId, widgetId);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads/export')
	async exportLeads(
		@CurrentUser('id') userId: string,
		@Param('id') widgetId: string,
		@Query('format') format: string,
		@Res() res: Response
	) {
		const fmt = format === 'xlsx' ? 'xlsx' : 'csv';
		const result = await this.widgetService.exportLeads(
			userId,
			widgetId,
			fmt
		);
		res.setHeader('Content-Type', result.contentType);
		res.setHeader(
			'Content-Disposition',
			`attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`
		);
		res.send(result.data);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads')
	async getLeads(
		@CurrentUser('id') userId: string,
		@Param('id') widgetId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.widgetService.getLeads(
			userId,
			widgetId,
			page ? parseInt(page) : 1,
			limit ? parseInt(limit) : 50
		);
	}

	// Public endpoint — no auth
	@HttpCode(200)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('submit')
	async submitLead(@Body() dto: SubmitLeadDto, @Req() req: Request) {
		return this.widgetService.submitLead(
			dto,
			undefined,
			getWidgetRequestDomain(req)
		);
	}

	// Serve widget.js — called from /widget/:key.js outside /api prefix
	@HttpCode(200)
	@Get('serve/:key')
	async serveWidgetConfig(
		@Param('key') key: string,
		@Req() req: Request,
		@Res() res: Response
	) {
		const config = await this.widgetService.getWidgetConfig(
			key,
			getWidgetRequestDomain(req)
		);

		if (!config) {
			res
				.status(200)
				.type('application/javascript')
				.send('/* widget inactive */');
			return;
		}

		const js = this.buildWidgetJs(key, config);
		res.status(200).type('application/javascript').send(js);
	}

	private buildWidgetJs(key: string, config: any): string {
		const configJson = JSON.stringify(config);
		return `
(function(d, w) {
  if (w.__ww_loaded_${key}) return;
  w.__ww_loaded_${key} = true;
  var config = ${configJson};
  config.key = '${key}';
  config.apiUrl = '${process.env.WIDGET_API_URL || 'https://winwidget.ru/api'}';

  var s = d.createElement('script');
  s.async = true;
  s.src = '${process.env.WIDGET_RUNTIME_URL || 'https://winwidget.ru'}/widget-runtime.js?' + Date.now();
  s.onload = function() {
    if (w.WinWidget) w.WinWidget.init(config);
  };
  d.head.appendChild(s);
})(document, window);
`.trim();
	}
}
