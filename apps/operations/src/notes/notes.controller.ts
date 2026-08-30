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
import { CreateNoteDto, UpdateNoteDto } from './notes.dto';
import { NotesService } from './notes.service';

@Controller('notes')
@OperationsAuth(['ADMIN'])
@UseGuards(OperationsAuthGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class NotesController {
	constructor(private readonly service: NotesService) {}

	@Get()
	@HttpCode(200)
	getAll(
		@Query('page', OPERATIONS_SCALAR_QUERY_PIPE) page?: string,
		@Query('limit', OPERATIONS_SCALAR_QUERY_PIPE) limit?: string,
		@Query('status', OPERATIONS_SCALAR_QUERY_PIPE) status?: string,
		@Query('createdFrom', OPERATIONS_SCALAR_QUERY_PIPE)
		createdFrom?: string,
		@Query('createdTo', OPERATIONS_SCALAR_QUERY_PIPE) createdTo?: string
	) {
		return this.service.getAll(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 10,
			{ status, createdFrom, createdTo }
		);
	}

	@Post()
	@HttpCode(200)
	create(
		@Body() dto: CreateNoteDto,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.service.create(dto, {
			actorId: actor.subject,
			...getOperationsClientContext(request)
		});
	}

	@Patch(':id')
	@HttpCode(200)
	update(
		@Param('id') id: string,
		@Body() dto: UpdateNoteDto,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.service.update(id, dto, {
			actorId: actor.subject,
			...getOperationsClientContext(request)
		});
	}

	@Delete(':id')
	@HttpCode(200)
	delete(
		@Param('id') id: string,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		return this.service.delete(id, {
			actorId: actor.subject,
			...getOperationsClientContext(request)
		});
	}
}
