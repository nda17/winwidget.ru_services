import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES } from '@/file/file.service';
import { UpdateAdminWidgetDto } from '@/widget-admin/dto/update-admin-widget.dto';
import { WidgetAdminService } from '@/widget-admin/widget-admin.service';
import { WidgetType } from '@/widget-domain/widget-lifecycle';
import {
	CloneWidgetSettingsDto,
	ExpectedDraftRevisionDto
} from '@/widget-settings/dto/widget-settings.dto';
import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	ParseEnumPipe,
	ParseIntPipe,
	Patch,
	Post,
	Query,
	Req,
	UploadedFile,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { Request } from 'express';

const adminWidgetTypePipe = new ParseEnumPipe(WidgetType, {
	exceptionFactory: () =>
		new BadRequestException('Некорректный тип виджета')
});

@Controller('widgets/admin')
@Auth([Role.ADMIN, Role.DEV])
export class WidgetAdminController {
	constructor(private readonly widgetAdminService: WidgetAdminService) {}

	@Get(':type/:id')
	@HttpCode(200)
	getWidget(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string
	) {
		return this.widgetAdminService.getWidget(type, widgetId);
	}

	@Get(':type/:id/versions')
	@HttpCode(200)
	getVersions(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.widgetAdminService.getVersions(
			type,
			widgetId,
			page ? Number(page) : 1,
			limit ? Number(limit) : 20
		);
	}

	@Post(':type/:id/versions/:version/restore')
	@HttpCode(200)
	@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
	restoreVersion(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string,
		@Param('version', ParseIntPipe) version: number,
		@Body() dto: ExpectedDraftRevisionDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.widgetAdminService.restoreVersion(
			type,
			widgetId,
			version,
			dto.expectedDraftRevision,
			adminId,
			request
		);
	}

	@Post(':type/:id/clone')
	@HttpCode(201)
	@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
	cloneWidget(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string,
		@Body() dto: CloneWidgetSettingsDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.widgetAdminService.cloneWidget(
			type,
			widgetId,
			dto?.name,
			adminId,
			request
		);
	}

	@Get(':type/:id/runtime-status')
	@HttpCode(200)
	getRuntimeStatus(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string
	) {
		return this.widgetAdminService.getRuntimeStatus(type, widgetId);
	}

	@Get(':type/:id/analytics')
	@HttpCode(200)
	getAnalytics(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string,
		@Query('days') days?: string
	) {
		return this.widgetAdminService.getAnalytics(
			type,
			widgetId,
			days ? Number(days) : 30
		);
	}

	@Patch(':type/:id')
	@HttpCode(200)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	updateWidget(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string,
		@Body() dto: UpdateAdminWidgetDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.widgetAdminService.updateWidget(
			type,
			widgetId,
			dto,
			adminId,
			request
		);
	}

	@Delete(':type/:id')
	@Auth([Role.ADMIN, Role.DEV])
	@HttpCode(200)
	deleteWidget(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.widgetAdminService.deleteWidget(
			type,
			widgetId,
			adminId,
			request
		);
	}

	@Post(':type/:id/publish')
	@HttpCode(200)
	@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
	publishWidget(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string,
		@Body() dto: ExpectedDraftRevisionDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.widgetAdminService.publishWidget(
			type,
			widgetId,
			dto.expectedDraftRevision,
			adminId,
			request
		);
	}

	@Post(':type/:id/discard-draft')
	@HttpCode(200)
	@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
	discardDraft(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string,
		@Body() dto: ExpectedDraftRevisionDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.widgetAdminService.discardDraft(
			type,
			widgetId,
			dto.expectedDraftRevision,
			adminId,
			request
		);
	}

	@Post(':type/:id/button-image')
	@HttpCode(200)
	@UseInterceptors(
		FileInterceptor('file', {
			limits: { fileSize: WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES }
		})
	)
	uploadButtonImage(
		@Param('type', adminWidgetTypePipe) type: WidgetType,
		@Param('id') widgetId: string,
		@Body('expectedDraftRevision', ParseIntPipe)
		expectedDraftRevision: number,
		@UploadedFile() file: Express.Multer.File | undefined,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.widgetAdminService.uploadButtonImage(
			type,
			widgetId,
			file,
			expectedDraftRevision,
			adminId,
			request
		);
	}
}
