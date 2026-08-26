import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Post,
	Req,
	UploadedFile,
	UseGuards,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { CurrentOperationsActor } from '../auth/current-operations-actor.decorator';
import {
	OperationsAuth,
	OperationsAuthGuard
} from '../auth/operations-auth.guard';
import type { OperationsActor } from '../auth/operations-request';
import { getOperationsClientContext } from '../common/operations-request-context';
import {
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	UploadedRestoreFile
} from './database-restore.contract';
import { EnqueueDatabaseRestoreDto } from './database-restore.dto';
import { DatabaseRestoreService } from './database-restore.service';

@Controller('dev-tools')
@OperationsAuth(['DEV'])
@UseGuards(OperationsAuthGuard)
export class DatabaseRestoreController {
	constructor(private readonly restores: DatabaseRestoreService) {}

	@Get('database-restores/settings')
	@HttpCode(200)
	settings() {
		return this.restores.getSettings();
	}

	@Get('database-restores/jobs/:jobId')
	@HttpCode(200)
	getJob(@Param('jobId') jobId: string) {
		return this.restores.getJob(jobId);
	}

	@Post('database-restores/jobs/:jobId/cancel')
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

	@Post('database-restores/:target')
	@HttpCode(202)
	@UsePipes(
		new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
	)
	@UseInterceptors(
		FileInterceptor('file', {
			limits: { fileSize: DATABASE_RESTORE_MAX_FILE_SIZE_BYTES }
		})
	)
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
}
