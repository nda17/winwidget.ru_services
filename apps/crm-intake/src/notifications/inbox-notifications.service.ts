import {
	Injectable,
	NotFoundException,
	ForbiddenException
} from '@nestjs/common';
import {
	assertIntakePermission,
	type IntakeAuthorization
} from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { intakeEntryScope } from '../intake/intake.service';
import type {
	InboxNotificationsQuery,
	InboxNotificationReadDto
} from './inbox-notifications.dto';

@Injectable()
export class InboxNotificationsService {
	constructor(private readonly prisma: CrmIntakePrismaService) {}
	private scope(access: IntakeAuthorization, workspaceId: string) {
		assertIntakePermission(access, 'intake:read');
		if (access.workspaceId !== workspaceId) throw new ForbiddenException();
		return { workspaceId, entry: intakeEntryScope(access) };
	}
	async list(access: IntakeAuthorization, query: InboxNotificationsQuery) {
		const scope = this.scope(access, query.workspaceId);
		const unread = {
			reads: {
				none: { recipientSubject: access.subject, readAt: { not: null } }
			}
		};
		const where = {
			...scope,
			...(query.unreadOnly === 'true' ? unread : {})
		};
		return this.prisma.$transaction(
			async tx => {
				const [total, unreadCount, rows] = await Promise.all([
					tx.inboxNotification.count({ where }),
					tx.inboxNotification.count({ where: { ...scope, ...unread } }),
					tx.inboxNotification.findMany({
						where,
						orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
						skip: (query.page - 1) * query.pageSize,
						take: query.pageSize,
						include: {
							entry: { select: { title: true } },
							reads: { where: { recipientSubject: access.subject } }
						}
					})
				]);
				return {
					schemaVersion: 1,
					workspaceId: query.workspaceId,
					page: query.page,
					pageSize: query.pageSize,
					total,
					unreadCount,
					items: rows.map(row => ({
						id: row.id,
						entryId: row.entryId,
						title: row.entry.title,
						createdAt: row.createdAt.toISOString(),
						readAt: row.reads[0]?.readAt?.toISOString() ?? null
					}))
				};
			},
			{ isolationLevel: 'RepeatableRead' }
		);
	}
	async setRead(
		access: IntakeAuthorization,
		id: string,
		dto: InboxNotificationReadDto
	) {
		const scope = this.scope(access, dto.workspaceId);
		return this.prisma.$transaction(async tx => {
			const notification = await tx.inboxNotification.findFirst({
				where: { id, ...scope }
			});
			if (!notification) throw new NotFoundException();
			const row = await tx.inboxNotificationRead.upsert({
				where: {
					notificationId_recipientSubject: {
						notificationId: id,
						recipientSubject: access.subject
					}
				},
				create: {
					notificationId: id,
					workspaceId: dto.workspaceId,
					recipientSubject: access.subject,
					readAt: dto.read ? new Date() : null
				},
				update: { readAt: dto.read ? new Date() : null }
			});
			return {
				schemaVersion: 1,
				workspaceId: dto.workspaceId,
				id,
				readAt: row.readAt?.toISOString() ?? null
			};
		});
	}
}
