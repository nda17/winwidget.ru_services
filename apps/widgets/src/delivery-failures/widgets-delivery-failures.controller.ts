import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request } from 'express';
import { WidgetsRoles } from '../auth/widgets-auth.decorator';
import {
	WidgetsApiGuard,
	WidgetsAuthGuard
} from '../auth/widgets-auth.guard';
import type { IntrospectedWidgetsActor } from '../internal/widgets-identity.client';
import {
	CurrentWidgetsActor,
	requestCorrelationId,
	WIDGETS_SCALAR_QUERY_PIPE
} from '../http/widgets-http.util';
import { CloseDeliveryFailureDto } from '../http/widgets.dto';
import { WidgetsDeliveryFailuresService } from './widgets-delivery-failures.service';

@Controller('widgets/admin/delivery-failures')
@UseGuards(WidgetsApiGuard, WidgetsAuthGuard)
@WidgetsRoles('ADMIN', 'DEV')
@UsePipes(
	new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
)
export class WidgetsDeliveryFailuresController {
	constructor(private readonly failures: WidgetsDeliveryFailuresService) {}

	@Get()
	@HttpCode(200)
	list(
		@Query('page', WIDGETS_SCALAR_QUERY_PIPE) page?: string,
		@Query('limit', WIDGETS_SCALAR_QUERY_PIPE) limit?: string,
		@Query('integration', WIDGETS_SCALAR_QUERY_PIPE) integration?: string,
		@Query('category', WIDGETS_SCALAR_QUERY_PIPE) category?: string,
		@Query('status', WIDGETS_SCALAR_QUERY_PIPE) status?: string
	) {
		return this.failures.list(Number(page) || 1, Number(limit) || 20, {
			integration,
			category,
			status
		});
	}

	@Get(':id')
	@HttpCode(200)
	get(@Param('id', ParseUUIDPipe) id: string) {
		return this.failures.get(id);
	}

	@Post(':id/retry')
	@HttpCode(200)
	@WidgetsRoles('DEV')
	retry(
		@Param('id', ParseUUIDPipe) id: string,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Req() request: Request
	) {
		return this.failures.retry(
			id,
			actor.subject,
			requestCorrelationId(request)
		);
	}

	@Post(':id/close')
	@HttpCode(200)
	@WidgetsRoles('DEV')
	close(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() dto: CloseDeliveryFailureDto,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Req() request: Request
	) {
		return this.failures.close(
			id,
			actor.subject,
			dto.comment,
			requestCorrelationId(request)
		);
	}
}
