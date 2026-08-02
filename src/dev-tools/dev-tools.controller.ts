import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { DATABASE_RESTORE_MAX_FILE_SIZE_BYTES as DATABASE_RESTORE_QUEUE_MAX_FILE_SIZE_BYTES } from '@/dev-tools/database-restore-queue.contract';
import { DatabaseRestoreQueueService } from '@/dev-tools/database-restore-queue.service';
import {
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	DatabaseRestoreService
} from '@/dev-tools/database-restore.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Post,
	Req,
	ServiceUnavailableException,
	UploadedFile,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { Request } from 'express';

class RestoreDatabaseBackupDto {
	@IsString()
	confirmation: string;

	@IsOptional()
	@IsUUID('4')
	requestId?: string;
}

@Controller('dev-tools')
@Auth(Role.DEV)
export class DevToolsController {
	constructor(
		private readonly databaseRestoreService: DatabaseRestoreService,
		private readonly databaseRestoreQueueService: DatabaseRestoreQueueService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@HttpCode(200)
	@Get('database-restores/settings')
	getDatabaseRestoreQueueSettings() {
		return this.databaseRestoreQueueService.getSettings();
	}

	@HttpCode(200)
	@Get('database-restores/jobs/:jobId')
	getDatabaseRestoreJob(@Param('jobId') jobId: string) {
		return this.databaseRestoreQueueService.getJob(jobId);
	}

	@HttpCode(202)
	@Post('database-restores/jobs/:jobId/cancel')
	async cancelDatabaseRestoreJob(
		@Param('jobId') jobId: string,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.databaseRestoreQueueService.cancel(jobId, async job => {
			const auditRecord = await this.adminEventLogService.record({
				adminId,
				section: 'DEV_TOOLS',
				action: 'DEV_DATABASE_RESTORE',
				description:
					`DEV запросил отмену восстановления базы ${job.target} ` +
					'до начала защищённой фазы',
				entityType: 'database_restore_job',
				entityId: job.jobId,
				entityLabel: job.originalFileName,
				metadata: {
					jobId: job.jobId,
					target: job.target,
					status: job.status,
					fileName: job.originalFileName,
					sha256: job.sha256,
					cancellationRequested: true
				},
				request
			});
			if (!auditRecord) {
				throw new ServiceUnavailableException(
					'Не удалось записать отмену восстановления в журнал событий'
				);
			}
		});
	}

	@HttpCode(202)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('database-restores/:target')
	@UseInterceptors(
		FileInterceptor('file', {
			limits: { fileSize: DATABASE_RESTORE_QUEUE_MAX_FILE_SIZE_BYTES }
		})
	)
	async enqueueDatabaseRestore(
		@Param('target') target: string,
		@UploadedFile() file: Express.Multer.File | undefined,
		@Body() dto: RestoreDatabaseBackupDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.databaseRestoreQueueService.enqueue(
			target,
			file,
			dto.confirmation,
			adminId,
			async job => {
				const auditRecord = await this.adminEventLogService.record({
					adminId,
					section: 'DEV_TOOLS',
					action: 'DEV_DATABASE_RESTORE',
					description:
						`DEV запросил восстановление базы ${job.target} ` +
						'через защищённую очередь',
					entityType: 'database_restore_job',
					entityId: job.jobId,
					entityLabel: job.originalFileName,
					metadata: {
						jobId: job.jobId,
						target: job.target,
						requestedStatus: job.status,
						queuePublication: 'PENDING',
						fileName: job.originalFileName,
						fileSize: job.fileSize,
						sha256: job.sha256
					},
					request
				});
				if (!auditRecord) {
					throw new ServiceUnavailableException(
						'Не удалось записать восстановление в журнал событий'
					);
				}
			},
			dto.requestId,
			async publication => {
				const auditEventId = `database_restore_publish_${publication.job.jobId}`;
				const auditRecord = await this.adminEventLogService.recordOnce(
					auditEventId,
					{
						adminId,
						section: 'DEV_TOOLS',
						action: 'DEV_DATABASE_RESTORE_PUBLISHED',
						description:
							`Подписанное задание восстановления базы ${publication.job.target} ` +
							'опубликовано в защищённую очередь',
						entityType: 'database_restore_job',
						entityId: publication.job.jobId,
						entityLabel: publication.job.originalFileName,
						metadata: {
							jobId: publication.job.jobId,
							target: publication.job.target,
							publishedStatus: publication.manifestStatus,
							queuePublication: 'CONFIRMED',
							manifestSignature: publication.manifestSignature,
							appRevision:
								publication.productionPermit?.appRevision ?? null,
							permitExpiresAt:
								publication.productionPermit?.expiresAt ?? null,
							runId: publication.productionPermit?.runId ?? null,
							evidence: publication.productionPermit?.evidence ?? null,
							incident: publication.productionPermit?.incident ?? null
						},
						request
					}
				);
				if (!auditRecord) {
					throw new ServiceUnavailableException(
						'Не удалось подтвердить публикацию восстановления в журнале событий'
					);
				}
				return { auditEventId: auditRecord.id };
			}
		);
	}

	@HttpCode(200)
	@Get('database-backup/restore-settings')
	getDatabaseRestoreSettings() {
		return this.databaseRestoreService.getSettings();
	}

	@HttpCode(200)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('database-backup/restore')
	@UseInterceptors(
		FileInterceptor('file', {
			limits: { fileSize: DATABASE_RESTORE_MAX_FILE_SIZE_BYTES }
		})
	)
	async restoreDatabaseBackup(
		@UploadedFile() file: Express.Multer.File | undefined,
		@Body() dto: RestoreDatabaseBackupDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		await this.adminEventLogService.record({
			adminId,
			section: 'DEV_TOOLS',
			action: 'DEV_DATABASE_RESTORE',
			description:
				'DEV запросил legacy-восстановление основной базы из backup',
			entityType: 'database_backup',
			entityId: file?.originalname ?? 'unknown',
			entityLabel: file?.originalname ?? 'unknown',
			metadata: {
				fileName: file?.originalname ?? null,
				fileSize: file?.size ?? null
			},
			request
		});

		return this.databaseRestoreService.restore(file, dto.confirmation);
	}
}
