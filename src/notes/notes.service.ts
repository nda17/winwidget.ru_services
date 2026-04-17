import { CreateNoteDto } from '@/notes/dto/create-note.dto';
import { UpdateNoteDto } from '@/notes/dto/update-note.dto';
import { PrismaService } from '@/prisma.service';
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class NotesService {
	constructor(private readonly prisma: PrismaService) {}

	async getAll() {
		return this.prisma.note.findMany({ orderBy: { createdAt: 'desc' } });
	}

	async create(dto: CreateNoteDto) {
		return this.prisma.note.create({ data: { text: dto.text } });
	}

	async update(id: string, dto: UpdateNoteDto) {
		await this.findOneOrFail(id);
		return this.prisma.note.update({ where: { id }, data: dto });
	}

	async delete(id: string) {
		await this.findOneOrFail(id);
		return this.prisma.note.delete({ where: { id } });
	}

	private async findOneOrFail(id: string) {
		const note = await this.prisma.note.findUnique({ where: { id } });
		if (!note) throw new NotFoundException('Note not found');
		return note;
	}
}
