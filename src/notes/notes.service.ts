import { CreateNoteDto } from '@/notes/dto/create-note.dto';
import { UpdateNoteDto } from '@/notes/dto/update-note.dto';
import { PrismaService } from '@/prisma.service';
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class NotesService {
	constructor(private readonly prisma: PrismaService) {}

	async getAll(page = 1, limit = 10) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [items, total, doneTotal] = await Promise.all([
			this.prisma.note.findMany({
				orderBy: [{ done: 'asc' }, { createdAt: 'desc' }],
				skip,
				take: normalizedLimit
			}),
			this.prisma.note.count(),
			this.prisma.note.count({ where: { done: true } })
		]);

		return {
			items,
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit)),
			doneTotal
		};
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
