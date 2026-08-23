import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CreateNoteDto } from '@/notes/dto/create-note.dto';
import { UpdateNoteDto } from '@/notes/dto/update-note.dto';
import { NotesService } from '@/notes/notes.service';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Query,
	Req
} from '@nestjs/common';
import { Request } from 'express';

@Controller('/notes')
@Auth('ADMIN')
export class NotesController {
	constructor(
		private readonly notesService: NotesService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@HttpCode(200)
	@Get()
	getAll(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('status') status?: string,
		@Query('createdFrom') createdFrom?: string,
		@Query('createdTo') createdTo?: string
	) {
		return this.notesService.getAll(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 10,
			{
				status,
				createdFrom,
				createdTo
			}
		);
	}

	@HttpCode(200)
	@Post()
	async create(
		@Body() dto: CreateNoteDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const note = await this.notesService.create(dto);

		await this.adminEventLogService.record({
			adminId,
			section: 'BACKLOG',
			action: 'BACKLOG_TASK_CREATE',
			description: 'Создана задача в бэклоге',
			entityType: 'backlog_task',
			entityId: note.id,
			entityLabel: note.text,
			metadata: {
				text: note.text
			},
			request
		});

		return note;
	}

	@HttpCode(200)
	@Patch(':id')
	async update(
		@Param('id') id: string,
		@Body() dto: UpdateNoteDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const note = await this.notesService.update(id, dto);

		await this.adminEventLogService.record({
			adminId,
			section: 'BACKLOG',
			action: 'BACKLOG_TASK_UPDATE',
			description:
				typeof dto.done === 'boolean'
					? dto.done
						? 'Задача бэклога отмечена выполненной'
						: 'С задачи бэклога снята отметка выполнения'
					: 'Обновлена задача в бэклоге',
			entityType: 'backlog_task',
			entityId: note.id,
			entityLabel: note.text,
			metadata: {
				text: note.text,
				done: note.done,
				updatedFields: Object.keys(dto)
			},
			request
		});

		return note;
	}

	@HttpCode(200)
	@Delete(':id')
	async delete(
		@Param('id') id: string,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const note = await this.notesService.delete(id);

		await this.adminEventLogService.record({
			adminId,
			section: 'BACKLOG',
			action: 'BACKLOG_TASK_DELETE',
			description: 'Удалена задача из бэклога',
			entityType: 'backlog_task',
			entityId: note.id,
			entityLabel: note.text,
			metadata: {
				text: note.text,
				done: note.done
			},
			request
		});

		return note;
	}
}
