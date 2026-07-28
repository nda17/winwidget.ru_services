import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES } from '@/file/file.service';
import { UpdateAdminWidgetDto } from '@/widget-admin/dto/update-admin-widget.dto';
import { WidgetAdminService } from '@/widget-admin/widget-admin.service';
import { WidgetType } from '@/widget-domain/widget-lifecycle';
import { ExpectedDraftRevisionDto } from '@/widget-settings/dto/widget-settings.dto';
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
