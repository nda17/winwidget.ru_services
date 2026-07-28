import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import {
	CloneWidgetSettingsDto,
	ExpectedDraftRevisionDto
} from '@/widget-settings/dto/widget-settings.dto';
import { WidgetSettingsService } from '@/widget-settings/widget-settings.service';
import {
	parseWidgetTypeSlug,
	WidgetType
} from '@/widget-domain/widget-lifecycle';
import {
	BadRequestException,
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	ParseIntPipe,
	PipeTransform,
	Post,
	Query,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';

class WidgetTypeSlugPipe implements PipeTransform<string, WidgetType> {
	transform(value: string) {
		const type = parseWidgetTypeSlug(value);
		if (!type) throw new BadRequestException('Некорректный тип виджета');
		return type;
	}
}

const widgetTypeSlugPipe = new WidgetTypeSlugPipe();

@Controller('widget-settings')
@Auth()
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WidgetSettingsController {
	constructor(
		private readonly widgetSettingsService: WidgetSettingsService
	) {}

	@Get(':type/:id')
	@HttpCode(200)
	getState(
		@Param('type', widgetTypeSlugPipe) type: WidgetType,
		@Param('id') widgetId: string,
		@CurrentUser('id') userId: string
	) {
		return this.widgetSettingsService.getState(type, widgetId, userId);
	}

	@Post(':type/:id/publish')
	@HttpCode(200)
	publish(
		@Param('type', widgetTypeSlugPipe) type: WidgetType,
		@Param('id') widgetId: string,
		@CurrentUser('id') userId: string,
		@Body() dto: ExpectedDraftRevisionDto
	) {
		return this.widgetSettingsService.publish(
			type,
			widgetId,
			userId,
			dto.expectedDraftRevision
		);
	}

	@Get(':type/:id/versions')
	@HttpCode(200)
	getVersions(
		@Param('type', widgetTypeSlugPipe) type: WidgetType,
		@Param('id') widgetId: string,
		@CurrentUser('id') userId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.widgetSettingsService.getVersions(
			type,
			widgetId,
			userId,
			page ? Number(page) : 1,
			limit ? Number(limit) : 20
		);
	}

	@Post(':type/:id/versions/:version/restore')
	@HttpCode(200)
	restoreVersion(
		@Param('type', widgetTypeSlugPipe) type: WidgetType,
		@Param('id') widgetId: string,
		@Param('version', ParseIntPipe) version: number,
		@CurrentUser('id') userId: string,
		@Body() dto: ExpectedDraftRevisionDto
	) {
		return this.widgetSettingsService.restoreVersion(
			type,
			widgetId,
			version,
			userId,
			dto.expectedDraftRevision
		);
	}

	@Post(':type/:id/clone')
	@HttpCode(201)
	clone(
		@Param('type', widgetTypeSlugPipe) type: WidgetType,
		@Param('id') widgetId: string,
		@CurrentUser('id') userId: string,
		@Body() dto: CloneWidgetSettingsDto
	) {
		return this.widgetSettingsService.clone(
			type,
			widgetId,
			userId,
			dto?.name
		);
	}

	@Post(':type/:id/discard-draft')
	@HttpCode(200)
	discardDraft(
		@Param('type', widgetTypeSlugPipe) type: WidgetType,
		@Param('id') widgetId: string,
		@CurrentUser('id') userId: string,
		@Body() dto: ExpectedDraftRevisionDto
	) {
		return this.widgetSettingsService.discardDraft(
			type,
			widgetId,
			userId,
			dto.expectedDraftRevision
		);
	}
}
