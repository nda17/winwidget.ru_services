import {
	Controller,
	Get,
	HttpCode,
	Param,
	Post,
	Query,
	Req,
	UseGuards
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentOperationsActor } from '../auth/current-operations-actor.decorator';
import {
	OperationsAuth,
	OperationsAuthGuard
} from '../auth/operations-auth.guard';
import { AdminEventLogService } from './admin-event-log.service';
import type { OperationsActor } from '../auth/operations-request';
import {
	getOperationsClientContext,
	OPERATIONS_SCALAR_QUERY_PIPE
} from '../common/operations-request-context';
import { AdminAuditFailureService } from '../messaging/admin-audit-failure.service';

@Controller('admin-event-log')
@OperationsAuth(['ADMIN'])
@UseGuards(OperationsAuthGuard)
export class AdminEventLogController {
	constructor(
		private readonly service: AdminEventLogService,
		private readonly failures: AdminAuditFailureService
	) {}

	@Get('failures')
	@HttpCode(200)
	failureList(
		@Query('page', OPERATIONS_SCALAR_QUERY_PIPE) page?: string,
		@Query('limit', OPERATIONS_SCALAR_QUERY_PIPE) limit?: string
	) {
		return this.failures.list(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20
		);
	}

	@Post('failures/:eventId/retry')
	@OperationsAuth(['DEV'])
	@HttpCode(202)
	retryFailure(
		@Param('eventId') eventId: string,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.failures.retry(eventId, {
			actorId: actor.subject,
			...getOperationsClientContext(request)
		});
	}

	@Get()
	@HttpCode(200)
	getAll(
		@Query('page', OPERATIONS_SCALAR_QUERY_PIPE) page?: string,
		@Query('limit', OPERATIONS_SCALAR_QUERY_PIPE) limit?: string,
		@Query('userId', OPERATIONS_SCALAR_QUERY_PIPE) userId?: string,
		@Query('adminId', OPERATIONS_SCALAR_QUERY_PIPE) adminId?: string,
		@Query('section', OPERATIONS_SCALAR_QUERY_PIPE) section?: string,
		@Query('action', OPERATIONS_SCALAR_QUERY_PIPE) action?: string,
		@Query('createdFrom', OPERATIONS_SCALAR_QUERY_PIPE)
		createdFrom?: string,
		@Query('createdTo', OPERATIONS_SCALAR_QUERY_PIPE) createdTo?: string
	) {
		return this.service.getAll(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{
				userId,
				adminId,
				section,
				action,
				createdFrom,
				createdTo
			}
		);
	}
}
