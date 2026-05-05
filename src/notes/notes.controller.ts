import { Auth } from '@/auth/decorators/auth.decorator';
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
	Query
} from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('/notes')
@Auth(Role.ADMIN)
export class NotesController {
	constructor(private readonly notesService: NotesService) {}

	@HttpCode(200)
	@Get()
	getAll(@Query('page') page?: string, @Query('limit') limit?: string) {
		return this.notesService.getAll(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 10
		);
	}

	@HttpCode(200)
	@Post()
	create(@Body() dto: CreateNoteDto) {
		return this.notesService.create(dto);
	}

	@HttpCode(200)
	@Patch(':id')
	update(@Param('id') id: string, @Body() dto: UpdateNoteDto) {
		return this.notesService.update(id, dto);
	}

	@HttpCode(200)
	@Delete(':id')
	delete(@Param('id') id: string) {
		return this.notesService.delete(id);
	}
}
