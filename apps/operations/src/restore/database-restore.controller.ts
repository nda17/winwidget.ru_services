import {
	BadRequestException,
	Body,
	CallHandler,
	Controller,
	ExecutionContext,
	Get,
	HttpCode,
	Injectable,
	NestInterceptor,
	Param,
	Post,
	Req,
	Type,
	UploadedFile,
	UseGuards,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { CurrentOperationsActor } from '../auth/current-operations-actor.decorator';
import {
	OperationsAuth,
	OperationsAuthGuard
} from '../auth/operations-auth.guard';
import type { OperationsActor } from '../auth/operations-request';
import { getOperationsClientContext } from '../common/operations-request-context';
import {
	DATABASE_RESTORE_UPLOAD_LIMITS,
	UploadedRestoreFile
} from './database-restore.contract';
import {
	CreateDatabaseRestorePermitDto,
	CreateDatabaseRestoreRecoveryActionDto,
	EnqueueDatabaseRestoreDto
} from './database-restore.dto';
import { DatabaseRestoreAuthorizationService } from './database-restore-authorization.service';
import { DatabaseRestoreService } from './database-restore.service';

const MULTER_FIELD_NESTING_ERROR_CODE = 'LIMIT_FIELD_NESTING';

export const transformDatabaseRestoreUploadException = (
	error: unknown
): unknown => {
	if (
		error instanceof Error &&
		'code' in error &&
		error.code === MULTER_FIELD_NESTING_ERROR_CODE
	) {
		return new BadRequestException(error.message);
	}
	return error;
};

export const DatabaseRestoreUploadInterceptor =
	(): Type<NestInterceptor> => {
		const BaseInterceptor = FileInterceptor('file', {
			limits: DATABASE_RESTORE_UPLOAD_LIMITS
		});

		@Injectable()
		class DatabaseRestoreFileInterceptor extends BaseInterceptor {
			override async intercept(
				context: ExecutionContext,
				next: CallHandler
			): Promise<Observable<unknown>> {
				try {
					return await super.intercept(context, next);
				} catch (error) {
					throw transformDatabaseRestoreUploadException(error);
				}
			}
		}

		return DatabaseRestoreFileInterceptor;
	};

@Controller('dev-tools')
@OperationsAuth(['ADMIN', 'DEV'])
@UseGuards(OperationsAuthGuard)
export class DatabaseRestoreController {
	constructor(
		private readonly restores: DatabaseRestoreService,
		private readonly authorization: DatabaseRestoreAuthorizationService
	) {}

	@Get('database-restores/settings')
	@HttpCode(200)
	settings() {
		return this.restores.getSettings();
	}

	@Post('database-restores/permits')
	@OperationsAuth(['DEV'])
	@HttpCode(201)
	@UsePipes(
		new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
	)
	createPermit(
		@Body() dto: CreateDatabaseRestorePermitDto,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.authorization.createPermit(
			dto,
			this.actorContext(actor, request)
		);
	}

	@Post('database-restores/permits/:permitId/approve')
	@OperationsAuth(['DEV'])
	@HttpCode(200)
	approvePermit(
		@Param('permitId') permitId: string,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.authorization.approvePermit(
			permitId,
			this.actorContext(actor, request)
		);
	}

	@Get('database-restores/jobs/:jobId')
	@HttpCode(200)
	getJob(@Param('jobId') jobId: string) {
		return this.restores.getJob(jobId);
	}

	@Post('database-restores/jobs/:jobId/cancel')
	@OperationsAuth(['DEV'])
	@HttpCode(202)
	cancel(
		@Param('jobId') jobId: string,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.restores.cancel(
			jobId,
			actor.subject,
			getOperationsClientContext(request)
		);
	}

	@Post('database-restores/jobs/:jobId/recovery-actions')
	@OperationsAuth(['DEV'])
	@HttpCode(201)
	@UsePipes(
		new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
	)
	createRecoveryAction(
		@Param('jobId') jobId: string,
		@Body() dto: CreateDatabaseRestoreRecoveryActionDto,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.authorization.createRecoveryAction(
			jobId,
			dto.action,
			this.actorContext(actor, request)
		);
	}

	@Post('database-restores/jobs/:jobId/recovery-actions/:actionId/approve')
	@OperationsAuth(['DEV'])
	@HttpCode(200)
	approveRecoveryAction(
		@Param('jobId') jobId: string,
		@Param('actionId') actionId: string,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.authorization.approveRecoveryAction(
			jobId,
			actionId,
			this.actorContext(actor, request)
		);
	}

	@Post('database-restores/:target')
	@OperationsAuth(['DEV'])
	@HttpCode(202)
	@UsePipes(
		new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
	)
	@UseInterceptors(DatabaseRestoreUploadInterceptor())
	enqueue(
		@Param('target') target: string,
		@UploadedFile() file: UploadedRestoreFile | undefined,
		@Body() dto: EnqueueDatabaseRestoreDto,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		const context = getOperationsClientContext(request);
		return this.restores.enqueue({
			target,
			file,
			confirmation: dto.confirmation,
			requestId: dto.requestId,
			actorId: actor.subject,
			ip: context.ip,
			userAgent: context.userAgent
		});
	}

	private actorContext(actor: OperationsActor, request: Request) {
		return {
			actorId: actor.subject,
			...getOperationsClientContext(request)
		};
	}
}
