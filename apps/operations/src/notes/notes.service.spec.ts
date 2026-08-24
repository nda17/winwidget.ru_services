import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { NotesService } from './notes.service';

describe('NotesService transactional audit', () => {
	const context = {
		actorId: 'admin-1',
		ip: '127.0.0.1',
		userAgent: 'test',
		correlationId: '1d2b7d09-a576-4d11-8899-edda6dc62d83'
	};
	const note = {
		id: 'note-1',
		text: 'Task',
		done: false,
		createdAt: new Date('2026-08-24T00:00:00.000Z'),
		updatedAt: new Date('2026-08-24T00:00:00.000Z')
	};

	function setup() {
		const transaction = {
			note: {
				create: jest.fn().mockResolvedValue(note),
				findUnique: jest.fn().mockResolvedValue(note),
				update: jest.fn().mockResolvedValue({ ...note, done: true }),
				delete: jest.fn().mockResolvedValue(note)
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as OperationsPrismaService;
		const audit = {
			recordInTransaction: jest.fn().mockResolvedValue({ id: 'audit-1' })
		} as unknown as AdminEventLogService;
		return {
			service: new NotesService(prisma, audit),
			prisma,
			transaction,
			audit
		};
	}

	it('creates the note and audit row in one transaction', async () => {
		const { service, prisma, transaction, audit } = setup();
		await expect(service.create({ text: 'Task' }, context)).resolves.toBe(
			note
		);
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(audit.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				adminId: 'admin-1',
				action: 'BACKLOG_TASK_CREATE',
				entityId: 'note-1'
			})
		);
	});

	it('updates the note and audit row in one transaction', async () => {
		const { service, prisma, transaction, audit } = setup();
		await service.update('note-1', { done: true }, context);
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(transaction.note.findUnique).toHaveBeenCalledWith({
			where: { id: 'note-1' }
		});
		expect(audit.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ action: 'BACKLOG_TASK_UPDATE' })
		);
	});

	it('deletes the note and audit row in one transaction', async () => {
		const { service, prisma, transaction, audit } = setup();
		await service.delete('note-1', context);
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(transaction.note.delete).toHaveBeenCalledWith({
			where: { id: 'note-1' }
		});
		expect(audit.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ action: 'BACKLOG_TASK_DELETE' })
		);
	});
});
