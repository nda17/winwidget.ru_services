import {
	BadRequestException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	Prisma,
	SupportConversation,
	SupportMessage,
	SupportAttachment
} from '@prisma/support-client';
import type { Request } from 'express';
import type { SupportActor } from '../auth/support-request';
import { enqueueSupportAdminAudit } from '../domain/support-admin-audit';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import {
	CreateSupportConversationDto,
	SupportAdminListDto,
	SupportCommandDto,
	SupportHistoryDto,
	SupportMessageDto,
	SupportNotificationSettingsDto,
	SupportStatusDto
} from './support-web.dto';
import { SupportWebIdentityClient } from './support-web-identity.client';
import {
	assertSupportActor,
	assertWebText,
	hashSupport,
	supportConflict,
	supportTransaction
} from './support-web.util';
import { SupportNotificationsService } from './support-notifications.service';

const SUPPORT_OPERATOR_DISPLAY_NAME = 'Специалист поддержки';

export function supportAttachmentDto(value: SupportAttachment) {
	return {
		id: value.id,
		fileName: value.fileName,
		mediaType: value.mediaType,
		byteSize: value.byteSize,
		width: value.width,
		height: value.height
	};
}
@Injectable()
export class SupportConversationsService {
	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly identity: SupportWebIdentityClient,
		private readonly notifications: SupportNotificationsService
	) {}

	async authorize(
		id: string,
		actor: SupportActor,
		operator = false,
		tx: Prisma.TransactionClient = this.prisma
	): Promise<SupportConversation> {
		const value = await tx.supportConversation.findFirst({
			where: { id, ...(!operator ? { authorSubject: actor.subject } : {}) }
		});
		if (!value) throw new NotFoundException('Обращение не найдено');
		return value;
	}
	async detail(id: string, actor: SupportActor, operator = false) {
		return this.conversationDto(
			await this.authorize(id, actor, operator),
			actor,
			operator
		);
	}
	async list(
		dto: SupportAdminListDto,
		actor: SupportActor,
		operator = false
	) {
		const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
		if (!operator)
			conditions.push(Prisma.sql`c.author_subject=${actor.subject}`);
		if (dto.status)
			conditions.push(Prisma.sql`c.status::text=${dto.status}`);
		const opposite = operator ? 'CLIENT' : 'OPERATOR';
		const unread = Prisma.sql`EXISTS(SELECT 1 FROM support.web_messages m WHERE m.conversation_id=c.id AND m.sender_kind::text=${opposite} AND m.sequence>COALESCE((SELECT r.through_sequence FROM support.web_read_states r WHERE r.conversation_id=c.id AND r.reader_subject=${actor.subject}),0))`;
		if (dto.unreadOnly) conditions.push(unread);
		if (dto.q?.trim()) {
			const text = `%${dto.q.trim().replace(/[\\%_]/g, '\\$&')}%`;
			conditions.push(
				Prisma.sql`(c.number::text=${dto.q.trim().replace(/^#/, '')} OR c.subject ILIKE ${text} OR c.author_name ILIKE ${text} OR c.company_name ILIKE ${text})`
			);
		}
		const where = Prisma.join(conditions, ' AND ');
		return this.prisma.$transaction(
			async tx => {
				const ids = await tx.$queryRaw<Array<{ id: string }>>(
					Prisma.sql`SELECT c.id FROM support.web_conversations c WHERE ${where} ORDER BY c.last_message_at DESC,c.id DESC LIMIT ${dto.limit} OFFSET ${(dto.page - 1) * dto.limit}`
				);
				const count = await tx.$queryRaw<Array<{ count: bigint }>>(
					Prisma.sql`SELECT count(*) FROM support.web_conversations c WHERE ${where}`
				);
				const rows = await tx.supportConversation.findMany({
					where: { id: { in: ids.map(row => row.id) } }
				});
				const items = await Promise.all(
					ids.map(row =>
						this.conversationDto(
							rows.find(item => item.id === row.id)!,
							actor,
							operator,
							tx
						)
					)
				);
				return {
					items,
					total: Number(count[0].count),
					page: dto.page,
					limit: dto.limit
				};
			},
			{ isolationLevel: 'RepeatableRead' }
		);
	}
	async history(
		id: string,
		dto: SupportHistoryDto,
		actor: SupportActor,
		operator = false
	) {
		if (
			dto.beforeSequence !== undefined &&
			dto.afterSequence !== undefined
		)
			throw new BadRequestException('Укажите только один курсор истории');
		return this.prisma.$transaction(
			async tx => {
				const conversation = await this.authorize(id, actor, operator, tx);
				const after = dto.afterSequence !== undefined;
				const rows = await tx.supportMessage.findMany({
					where: {
						conversationId: id,
						...(after
							? { sequence: { gt: dto.afterSequence } }
							: dto.beforeSequence !== undefined
								? { sequence: { lt: dto.beforeSequence } }
								: {})
					},
					orderBy: { sequence: after ? 'asc' : 'desc' },
					take: dto.limit + 1,
					include: { attachments: { orderBy: { createdAt: 'asc' } } }
				});
				const selected = rows.slice(0, dto.limit);
				if (!after) selected.reverse();
				return {
					items: selected.map(row => this.messageDto(row)),
					hasMore: rows.length > dto.limit,
					lastSequence: conversation.lastSequence
				};
			},
			{ isolationLevel: 'RepeatableRead' }
		);
	}
	async unreadCount(actor: SupportActor, operator = false) {
		const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(
			Prisma.sql`SELECT count(*) FROM support.web_messages m JOIN support.web_conversations c ON c.id=m.conversation_id LEFT JOIN support.web_read_states r ON r.conversation_id=c.id AND r.reader_subject=${actor.subject} WHERE ${operator ? Prisma.sql`TRUE` : Prisma.sql`c.author_subject=${actor.subject}`} AND m.sender_kind::text=${operator ? 'CLIENT' : 'OPERATOR'} AND m.sequence>COALESCE(r.through_sequence,0)`
		);
		return { unreadCount: Number(rows[0].count) };
	}
	async read(
		id: string,
		throughSequence: number,
		actor: SupportActor,
		operator = false
	) {
		return supportTransaction(this.prisma, async tx => {
			await this.lock(tx, id);
			const conversation = await this.authorize(id, actor, operator, tx);
			if (throughSequence > conversation.lastSequence)
				throw new BadRequestException(
					'Некорректная последовательность прочтения'
				);
			const result = await tx.$queryRaw<
				Array<{ throughSequence: number }>
			>(
				Prisma.sql`INSERT INTO support.web_read_states(id,conversation_id,reader_subject,through_sequence,updated_at) VALUES(gen_random_uuid(),${id}::uuid,${actor.subject},${throughSequence},now()) ON CONFLICT(conversation_id,reader_subject) DO UPDATE SET through_sequence=GREATEST(web_read_states.through_sequence,EXCLUDED.through_sequence),updated_at=now() RETURNING through_sequence AS "throughSequence"`
			);
			return result[0];
		});
	}
	async recover(commandId: string, actor: SupportActor) {
		const value = await this.prisma.supportCommand.findUnique({
			where: {
				actorSubject_commandId: { actorSubject: actor.subject, commandId }
			}
		});
		if (
			!value ||
			value.status !== 'COMPLETED' ||
			!['CREATE', 'CLIENT_REPLY', 'OPERATOR_REPLY', 'STATUS'].includes(
				value.operation
			)
		)
			return { state: 'NOT_FOUND' as const, commandId };
		const result = value.result as Record<string, unknown>;
		const conversation = (result.conversation ?? result) as Record<
			string,
			unknown
		>;
		const message = result.message as Record<string, unknown> | undefined;
		return {
			state: 'COMPLETED' as const,
			commandId,
			...(typeof conversation.id === 'string'
				? { conversationId: conversation.id }
				: {}),
			...(message ? { messageId: message.id } : {})
		};
	}
	async create(
		dto: CreateSupportConversationDto,
		actor: SupportActor,
		request: Request
	) {
		assertSupportActor(actor, dto.expectedActorSubject);
		const previous = await this.existing(actor, dto, 'CREATE', dto);
		if (previous) return previous;
		const author = await this.identity.author(
			request.headers.authorization!,
			dto.workspaceId
		);
		assertSupportActor(actor, author.subject);
		const companyName = dto.workspaceId
			? await this.identity.company(
					request.headers.authorization!,
					dto.workspaceId,
					actor.subject
				)
			: null;
		return this.command(actor, dto, 'CREATE', dto, async tx => {
			const recent = await tx.supportConversation.count({
				where: {
					authorSubject: actor.subject,
					createdAt: { gt: new Date(Date.now() - 3600000) }
				}
			});
			if (recent >= 10)
				throw new BadRequestException(
					'Можно создать не более 10 обращений в час'
				);
			const conversation = await tx.supportConversation.create({
				data: {
					authorSubject: actor.subject,
					authorName: author.name,
					workspaceId: dto.workspaceId ?? null,
					companyName,
					subject: assertWebText(dto.subject),
					section: dto.section,
					appVersion: dto.appVersion,
					lastSequence: 1,
					version: 1
				}
			});
			const message = await tx.supportMessage.create({
				data: {
					conversationId: conversation.id,
					senderSubject: actor.subject,
					senderName: author.name,
					senderKind: 'CLIENT',
					text: assertWebText(dto.text),
					sequence: 1
				}
			});
			await this.attach(
				tx,
				conversation.id,
				message.id,
				actor.subject,
				dto.attachmentIds,
				dto.draftId
			);
			await this.notifications.enqueue(
				tx,
				conversation,
				'NEW_CONVERSATION'
			);
			return {
				commandId: dto.commandId,
				conversation: await this.conversationDto(
					conversation,
					actor,
					false,
					tx
				),
				message: await this.loadMessage(tx, message.id)
			};
		});
	}
	async reply(
		id: string,
		dto: SupportMessageDto,
		actor: SupportActor,
		request: Request,
		operator = false
	) {
		assertSupportActor(actor, dto.expectedActorSubject);
		const operation = operator ? 'OPERATOR_REPLY' : 'CLIENT_REPLY';
		const input = { id, ...dto };
		const previous = await this.existing(actor, dto, operation, input);
		if (previous) return previous;
		await this.authorize(id, actor, operator);
		const author = await this.identity.author(
			request.headers.authorization!
		);
		assertSupportActor(actor, author.subject);
		return this.command(actor, dto, operation, input, async tx => {
			await this.lock(tx, id);
			const old = await this.authorize(id, actor, operator, tx);
			if (old.lastSequence >= 2147483646 || old.version >= 2147483646)
				throw new BadRequestException('Лимит переписки достигнут');
			const conversation = await tx.supportConversation.update({
				where: { id },
				data: {
					lastSequence: { increment: 1 },
					version: { increment: 1 },
					lastMessageAt: new Date(),
					status: operator
						? old.status === 'NEW'
							? 'IN_PROGRESS'
							: old.status
						: old.status === 'RESOLVED'
							? 'IN_PROGRESS'
							: old.status
				}
			});
			const message = await tx.supportMessage.create({
				data: {
					conversationId: id,
					senderSubject: actor.subject,
					senderName: operator
						? SUPPORT_OPERATOR_DISPLAY_NAME
						: author.name,
					senderKind: operator ? 'OPERATOR' : 'CLIENT',
					text: assertWebText(dto.text),
					sequence: conversation.lastSequence
				}
			});
			await this.attach(
				tx,
				id,
				message.id,
				actor.subject,
				dto.attachmentIds
			);
			await this.notifications.enqueue(
				tx,
				conversation,
				operator ? 'OPERATOR_REPLY' : 'CLIENT_MESSAGE'
			);
			if (operator)
				await enqueueSupportAdminAudit(tx, {
					actor,
					request,
					action: 'SUPPORT_CONVERSATION_REPLY',
					description: 'Отправлен ответ поддержки',
					entityType: 'support_conversation',
					entityId: id,
					entityLabel: `#${conversation.number}`,
					metadata: {
						messageId: message.id,
						sequence: message.sequence,
						aggregateVersion: conversation.version
					}
				});
			return {
				commandId: dto.commandId,
				conversation: await this.conversationDto(
					conversation,
					actor,
					operator,
					tx
				),
				message: await this.loadMessage(tx, message.id)
			};
		});
	}
	async status(
		id: string,
		dto: SupportStatusDto,
		actor: SupportActor,
		request: Request
	) {
		return this.command(actor, dto, 'STATUS', { id, ...dto }, async tx => {
			await this.lock(tx, id);
			const previous = await this.authorize(id, actor, true, tx);
			if (previous.version !== dto.expectedVersion)
				supportConflict('Обращение изменилось. Обновите данные.');
			const conversation = await tx.supportConversation.update({
				where: { id },
				data: { status: dto.status, version: { increment: 1 } }
			});
			await enqueueSupportAdminAudit(tx, {
				actor,
				request,
				action: 'SUPPORT_CONVERSATION_STATUS_UPDATE',
				description: 'Изменён статус обращения поддержки',
				entityType: 'support_conversation',
				entityId: id,
				entityLabel: `#${conversation.number}`,
				metadata: {
					oldStatus: previous.status,
					newStatus: conversation.status,
					aggregateVersion: conversation.version
				}
			});
			return this.conversationDto(conversation, actor, true, tx);
		});
	}
	async settings() {
		return this.notifications.serializeSettings(
			await this.notifications.settings()
		);
	}
	async updateSettings(
		dto: SupportNotificationSettingsDto,
		actor: SupportActor,
		request: Request
	) {
		this.notifications.validateSettings(dto);
		return this.command(actor, dto, 'SETTINGS', dto, async tx => {
			await this.notifications.settings(tx);
			await tx.$queryRaw(
				Prisma.sql`SELECT id FROM support.web_notification_settings WHERE id='singleton' FOR UPDATE`
			);
			const previous = await this.notifications.settings(tx);
			if (previous.version !== dto.expectedVersion)
				supportConflict('Настройки изменились. Обновите данные.');
			const {
				commandId: ignoredCommand,
				expectedActorSubject: ignoredActor,
				expectedVersion: ignoredVersion,
				...input
			} = dto;
			void ignoredCommand;
			void ignoredActor;
			void ignoredVersion;
			const data = {
				...input,
				staffEmails: [
					...new Set(
						input.staffEmails.map(email => email.toLowerCase().trim())
					)
				]
			};
			const changedFields = Object.keys(data).filter(
				key =>
					JSON.stringify(previous[key as keyof typeof previous]) !==
					JSON.stringify(data[key as keyof typeof data])
			);
			const updated = await tx.supportNotificationSettings.update({
				where: { id: 'singleton' },
				data: { ...data, version: { increment: 1 } }
			});
			await enqueueSupportAdminAudit(tx, {
				actor,
				request,
				action: 'SUPPORT_NOTIFICATION_SETTINGS_UPDATE',
				description: 'Обновлены настройки уведомлений веб-поддержки',
				entityType: 'support_notification_settings',
				entityId: 'singleton',
				entityLabel: null,
				metadata: { changedFields, aggregateVersion: updated.version }
			});
			return this.notifications.serializeSettings(updated);
		});
	}
	async existing(
		actor: SupportActor,
		dto: SupportCommandDto,
		operation: string,
		input: unknown,
		tx: Prisma.TransactionClient = this.prisma
	): Promise<any> {
		assertSupportActor(actor, dto.expectedActorSubject);
		const value = await tx.supportCommand.findUnique({
			where: {
				actorSubject_commandId: {
					actorSubject: actor.subject,
					commandId: dto.commandId
				}
			}
		});
		if (!value) return null;
		if (
			value.operation !== operation ||
			value.requestHash !== hashSupport(input)
		)
			supportConflict();
		if (value.status !== 'COMPLETED')
			supportConflict('Предыдущая команда ещё выполняется');
		const result = value.result as Prisma.JsonObject;
		if (
			operation === 'OPERATOR_REPLY' &&
			result.message &&
			typeof result.message === 'object' &&
			!Array.isArray(result.message)
		)
			return {
				...result,
				message: {
					...result.message,
					senderName: SUPPORT_OPERATOR_DISPLAY_NAME
				}
			};
		return value.result;
	}
	async command<T>(
		actor: SupportActor,
		dto: SupportCommandDto,
		operation: string,
		input: unknown,
		work: (tx: Prisma.TransactionClient) => Promise<T>
	): Promise<T> {
		assertSupportActor(actor, dto.expectedActorSubject);
		return supportTransaction(this.prisma, async tx => {
			const old = await this.existing(actor, dto, operation, input, tx);
			if (old) return old as T;
			const result = await work(tx);
			await tx.supportCommand.create({
				data: {
					actorSubject: actor.subject,
					commandId: dto.commandId,
					operation,
					requestHash: hashSupport(input),
					result: result as Prisma.InputJsonValue
				}
			});
			return result;
		});
	}
	private async lock(tx: Prisma.TransactionClient, id: string) {
		await tx.$queryRaw(
			Prisma.sql`SELECT id FROM support.web_conversations WHERE id=${id}::uuid FOR UPDATE`
		);
	}
	private async attach(
		tx: Prisma.TransactionClient,
		conversationId: string,
		messageId: string,
		ownerSubject: string,
		ids: string[],
		draftId?: string
	) {
		if (ids.length > 3 || new Set(ids).size !== ids.length)
			throw new BadRequestException('Некорректные вложения');
		if (!ids.length) return;
		const changed = await tx.supportAttachment.updateMany({
			where: {
				id: { in: ids },
				ownerSubject,
				status: 'TEMPORARY',
				messageId: null,
				expiresAt: { gt: new Date() },
				...(draftId
					? { draftId, conversationId: null }
					: { conversationId })
			},
			data: {
				status: 'ATTACHED',
				conversationId,
				messageId,
				draftId: null
			}
		});
		if (changed.count !== ids.length)
			throw new BadRequestException(
				'Вложения недоступны или уже отправлены'
			);
	}
	private async conversationDto(
		value: SupportConversation,
		actor: SupportActor,
		operator: boolean,
		tx: Prisma.TransactionClient = this.prisma
	) {
		const read = await tx.supportReadState.findUnique({
			where: {
				conversationId_readerSubject: {
					conversationId: value.id,
					readerSubject: actor.subject
				}
			}
		});
		const unreadCount = await tx.supportMessage.count({
			where: {
				conversationId: value.id,
				senderKind: operator ? 'CLIENT' : 'OPERATOR',
				sequence: { gt: read?.throughSequence ?? 0 }
			}
		});
		return {
			...value,
			unreadCount,
			createdAt: value.createdAt.toISOString(),
			updatedAt: value.updatedAt.toISOString(),
			lastMessageAt: value.lastMessageAt.toISOString()
		};
	}
	private messageDto(
		value: SupportMessage & { attachments: SupportAttachment[] }
	) {
		return {
			id: value.id,
			conversationId: value.conversationId,
			senderKind: value.senderKind,
			senderName:
				value.senderKind === 'OPERATOR'
					? SUPPORT_OPERATOR_DISPLAY_NAME
					: value.senderName,
			text: value.text,
			sequence: value.sequence,
			createdAt: value.createdAt.toISOString(),
			attachments: value.attachments.map(supportAttachmentDto)
		};
	}
	private async loadMessage(tx: Prisma.TransactionClient, id: string) {
		return this.messageDto(
			await tx.supportMessage.findUniqueOrThrow({
				where: { id },
				include: { attachments: { orderBy: { createdAt: 'asc' } } }
			})
		);
	}
}
