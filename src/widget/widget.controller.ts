import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CreateWidgetDto } from '@/widget/dto/create-widget.dto';
import { UpdateWidgetDto } from '@/widget/dto/update-widget.dto';
import { WidgetService } from '@/widget/widget.service';
import { WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES } from '@/file/file.service';
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
	Res,
	UploadedFile,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { Response } from 'express';

@Controller('widgets')
export class WidgetController {
	constructor(private readonly widgetService: WidgetService) {}

	@HttpCode(200)
	@Auth()
	@Get()
	async getMyWidgets(@CurrentUser('id') userId: string) {
		return this.widgetService.getMyWidgets(userId);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('admin/monitoring')
	async getAdminWidgetMonitoring(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('type') type?: string,
		@Query('isActive') isActive?: string,
		@Query('plan') plan?: string,
		@Query('search') search?: string
	) {
		return this.widgetService.getAdminWidgetMonitoring(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{ type, isActive, plan, search }
		);
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
	@Post(':id/button-image')
	@UseInterceptors(
		FileInterceptor('file', {
			limits: { fileSize: WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES }
		})
	)
	async uploadButtonImage(
		@CurrentUser('id') userId: string,
		@Param('id') widgetId: string,
		@UploadedFile() file?: Express.Multer.File
	) {
		return this.widgetService.uploadButtonImage(userId, widgetId, file);
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
}
