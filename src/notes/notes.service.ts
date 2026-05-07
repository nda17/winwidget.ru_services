import { CreateNoteDto } from '@/notes/dto/create-note.dto';
import { UpdateNoteDto } from '@/notes/dto/update-note.dto';
import { PrismaService } from '@/prisma.service';
import {
	BadRequestException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

interface AdminNoteFilters {
	status?: string;
	createdFrom?: string;
	createdTo?: string;
}

@Injectable()
export class NotesService {
	constructor(private readonly prisma: PrismaService) {}

	async getAll(page = 1, limit = 10, filters: AdminNoteFilters = {}) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
		const where = this.getAdminNoteWhere(filters);
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [items, total, doneTotal] = await Promise.all([
			this.prisma.note.findMany({
				where,
				orderBy: [{ done: 'asc' }, { createdAt: 'desc' }],
				skip,
				take: normalizedLimit
			}),
			this.prisma.note.count({ where }),
			this.prisma.note.count({
				where: {
					...(where ?? {}),
					done: true
				}
			})
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

	private getAdminNoteWhere(
		filters: AdminNoteFilters
	): Prisma.NoteWhereInput | undefined {
		const where: Prisma.NoteWhereInput = {};
		const status = this.normalizeStatus(filters.status);
		const createdAt = this.getDateRangeFilter(
			filters.createdFrom,
			filters.createdTo
		);

		if (status === 'DONE') where.done = true;
		if (status === 'PENDING') where.done = false;
		if (createdAt) where.createdAt = createdAt;

		return Object.keys(where).length ? where : undefined;
	}

	private normalizeStatus(value?: string) {
		const normalized = value?.trim().toUpperCase();

		if (!normalized) {
			return undefined;
		}

		if (normalized !== 'DONE' && normalized !== 'PENDING') {
			throw new BadRequestException('Некорректный статус задачи');
		}

		return normalized;
	}

	private getDateRangeFilter(from?: string, to?: string) {
		const gte = this.normalizeDate(from, false);
		const lte = this.normalizeDate(to, true);

		if (!gte && !lte) {
			return undefined;
		}

		return {
			...(gte ? { gte } : {}),
			...(lte ? { lte } : {})
		};
	}

	private normalizeDate(value?: string, endOfDay = false) {
		const normalized = value?.trim();

		if (!normalized) {
			return undefined;
		}

		const date = new Date(
			endOfDay
				? `${normalized}T23:59:59.999Z`
				: `${normalized}T00:00:00.000Z`
		);

		if (Number.isNaN(date.getTime())) {
			throw new BadRequestException('Некорректная дата фильтра');
		}

		return date;
	}
}
