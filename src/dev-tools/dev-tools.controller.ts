import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import {
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	DatabaseRestoreService
} from '@/dev-tools/database-restore.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Post,
	Req,
	UploadedFile,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { IsString } from 'class-validator';
import { Request } from 'express';

class RestoreDatabaseBackupDto {
	@IsString()
	confirmation: string;
}

@Controller('dev-tools')
@Auth(Role.DEV)
export class DevToolsController {
	constructor(
		private readonly databaseRestoreService: DatabaseRestoreService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

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
			description: 'Запущено восстановление базы данных из backup',
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
