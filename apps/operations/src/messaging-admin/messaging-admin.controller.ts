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
import { CurrentOperationsActor } from '../auth/current-operations-actor.decorator';
import {
	OperationsAuth,
	OperationsAuthGuard
} from '../auth/operations-auth.guard';
import type { OperationsActor } from '../auth/operations-request';
import {
	getOperationsClientContext,
	OPERATIONS_SCALAR_QUERY_PIPE
} from '../common/operations-request-context';
import { CloseMessagingFailureDto } from './messaging-admin.dto';
import { MessagingAdminService } from './messaging-admin.service';

@Controller('messaging/admin')
@UseGuards(OperationsAuthGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class MessagingAdminController {
	constructor(private readonly messaging: MessagingAdminService) {}

	@Get('overview')
	@OperationsAuth(['ADMIN', 'DEV'])
	@HttpCode(200)
	overview() {
		return this.messaging.getOverview();
	}

	@Get('failures')
	@OperationsAuth(['DEV'])
	@HttpCode(200)
	failures(
		@Query('page', OPERATIONS_SCALAR_QUERY_PIPE) page?: string,
		@Query('limit', OPERATIONS_SCALAR_QUERY_PIPE) limit?: string,
		@Query('integration', OPERATIONS_SCALAR_QUERY_PIPE)
		integration?: string,
		@Query('category', OPERATIONS_SCALAR_QUERY_PIPE) category?: string,
		@Query('status', OPERATIONS_SCALAR_QUERY_PIPE) status?: string
	) {
		return this.messaging.getFailures(
			Number(page || 1),
			Number(limit || 20),
			{
				integration,
				category,
				status
			}
		);
	}

	@Post('failures/:id/retry')
	@OperationsAuth(['DEV'])
	@HttpCode(200)
	retry(
		@Param('id', ParseUUIDPipe) id: string,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.messaging.retryFailure(id, actor.subject, {
			...getOperationsClientContext(request)
		});
	}

	@Post('failures/:id/close')
	@OperationsAuth(['DEV'])
	@HttpCode(200)
	close(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() dto: CloseMessagingFailureDto,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.messaging.closeFailure(id, actor.subject, dto.comment, {
			...getOperationsClientContext(request)
		});
	}
}
