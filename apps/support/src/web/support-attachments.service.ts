import {
	BadRequestException,
	Injectable,
	NotFoundException,
	OnApplicationShutdown,
	OnModuleInit,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/support-client';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import type { SupportActor } from '../auth/support-request';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportRuntimeService } from '../runtime/support-runtime.service';
import { SupportAttachmentStorageService } from './support-attachment-storage.service';
import {
	SupportConversationsService,
	supportAttachmentDto
} from './support-conversations.service';
import { SupportUploadDto } from './support-web.dto';
import {
	assertSupportActor,
	hashSupport,
	supportConflict,
	supportTransaction
} from './support-web.util';

@Injectable()
export class SupportAttachmentsService
	implements OnModuleInit, OnApplicationShutdown
{
	private timer: NodeJS.Timeout | null = null;
	private stopping = false;
	private running = false;
	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly conversations: SupportConversationsService,
		private readonly storage: SupportAttachmentStorageService,
		private readonly runtime: SupportRuntimeService
	) {}
	onModuleInit() {
		if (this.runtime.apiEnabled && this.runtime.webChatEnabled)
			this.schedule();
	}
	onApplicationShutdown() {
		this.stopping = true;
		if (this.timer) clearTimeout(this.timer);
	}
	private schedule() {
		if (this.stopping) return;
		this.timer = setTimeout(() => {
			void this.cleanup()
				.catch(() => undefined)
				.finally(() => this.schedule());
		}, 60000);
		this.timer.unref();
	}
	async upload(
		dto: SupportUploadDto,
		file: Express.Multer.File | undefined,
		actor: SupportActor
	) {
		assertSupportActor(actor, dto.expectedActorSubject);
		if (Boolean(dto.draftId) === Boolean(dto.conversationId))
			throw new BadRequestException('Укажите черновик или обращение');
		const operator = actor.roles.some(role =>
			['ADMIN', 'DEV'].includes(role)
		);
		if (dto.conversationId)
			await this.conversations.authorize(
				dto.conversationId,
				actor,
				operator
			);
		const prepared = await this.storage.prepare(file);
		const requestHash = hashSupport({
			...dto,
			sourceHash: prepared.sourceHash,
			fileName: prepared.fileName
		});
		const leaseToken = randomUUID();
		const value = await supportTransaction(this.prisma, async tx => {
			const command = await tx.supportCommand.findUnique({
				where: {
					actorSubject_commandId: {
						actorSubject: actor.subject,
						commandId: dto.commandId
					}
				}
			});
			if (
				command &&
				(command.operation !== 'UPLOAD' ||
					command.requestHash !== requestHash)
			)
				supportConflict();
			let attachment = await tx.supportAttachment.findUnique({
				where: {
					ownerSubject_commandId: {
						ownerSubject: actor.subject,
						commandId: dto.commandId
					}
				}
			});
			if (attachment) {
				if (attachment.requestHash !== requestHash) supportConflict();
				if (['TEMPORARY', 'ATTACHED'].includes(attachment.status))
					return attachment;
				if (
					attachment.status !== 'PREPARED' ||
					(attachment.leaseExpiresAt &&
						attachment.leaseExpiresAt > new Date())
				)
					supportConflict('Загрузка выполняется или уже удалена');
				const claimed = await tx.supportAttachment.updateMany({
					where: {
						id: attachment.id,
						status: 'PREPARED',
						leaseExpiresAt: { lte: new Date() }
					},
					data: {
						leaseToken,
						leaseExpiresAt: new Date(Date.now() + 60000)
					}
				});
				if (claimed.count !== 1)
					supportConflict('Загрузка уже выполняется');
				return attachment;
			}
			const count = await tx.supportAttachment.count({
				where: {
					ownerSubject: actor.subject,
					status: { in: ['PREPARED', 'TEMPORARY'] }
				}
			});
			if (count >= 30)
				throw new BadRequestException(
					'Слишком много незавершённых загрузок'
				);
			const id = randomUUID();
			attachment = await tx.supportAttachment.create({
				data: {
					id,
					ownerSubject: actor.subject,
					commandId: dto.commandId,
					requestHash,
					draftId: dto.draftId ?? null,
					conversationId: dto.conversationId ?? null,
					storageKey: `support/attachments/${id}`,
					fileName: prepared.fileName,
					mediaType: prepared.mediaType,
					byteSize: prepared.byteSize,
					width: prepared.width,
					height: prepared.height,
					contentHash: prepared.contentHash,
					expiresAt: new Date(Date.now() + 86400000),
					leaseToken,
					leaseExpiresAt: new Date(Date.now() + 60000)
				}
			});
			await tx.supportCommand.create({
				data: {
					actorSubject: actor.subject,
					commandId: dto.commandId,
					operation: 'UPLOAD',
					requestHash,
					status: 'PENDING',
					result: { attachmentId: id }
				}
			});
			return attachment;
		});
		if (['TEMPORARY', 'ATTACHED'].includes(value.status))
			return supportAttachmentDto(value);
		try {
			await this.storage.put(
				value.storageKey,
				prepared.body,
				prepared.mediaType
			);
		} catch (error) {
			await this.prisma.supportAttachment.updateMany({
				where: { id: value.id, status: 'PREPARED', leaseToken },
				data: { leaseExpiresAt: new Date() }
			});
			throw error;
		}
		return supportTransaction(this.prisma, async tx => {
			const activated = await tx.supportAttachment.updateMany({
				where: { id: value.id, status: 'PREPARED', leaseToken },
				data: {
					status: 'TEMPORARY',
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (activated.count !== 1)
				throw new ServiceUnavailableException(
					'Загрузка ещё не подтверждена. Повторите с той же командой.'
				);
			const attachment = await tx.supportAttachment.findUniqueOrThrow({
				where: { id: value.id }
			});
			await tx.supportCommand.update({
				where: {
					actorSubject_commandId: {
						actorSubject: actor.subject,
						commandId: dto.commandId
					}
				},
				data: {
					status: 'COMPLETED',
					result: { attachmentId: attachment.id }
				}
			});
			return supportAttachmentDto(attachment);
		});
	}
	async remove(id: string, actor: SupportActor) {
		const value = await this.prisma.supportAttachment.findFirst({
			where: { id, ownerSubject: actor.subject }
		});
		if (!value) throw new NotFoundException('Вложение не найдено');
		if (['DELETE_PENDING', 'DELETING', 'DELETED'].includes(value.status))
			return { deleted: true };
		if (value.status !== 'TEMPORARY')
			throw new BadRequestException(
				'Можно удалить только неотправленное вложение'
			);
		const updated = await this.prisma.supportAttachment.updateMany({
			where: {
				id,
				ownerSubject: actor.subject,
				status: 'TEMPORARY',
				messageId: null
			},
			data: { status: 'DELETE_PENDING', expiresAt: new Date() }
		});
		if (updated.count !== 1) supportConflict('Вложение уже отправлено');
		return { deleted: true };
	}
	async content(id: string, actor: SupportActor, response: Response) {
		const value = await this.prisma.supportAttachment.findUnique({
			where: { id }
		});
		if (!value || !['TEMPORARY', 'ATTACHED'].includes(value.status))
			throw new NotFoundException('Вложение не найдено');
		if (value.status === 'TEMPORARY') {
			if (
				value.ownerSubject !== actor.subject ||
				value.expiresAt < new Date()
			)
				throw new NotFoundException('Вложение не найдено');
		} else {
			if (!value.conversationId)
				throw new NotFoundException('Вложение не найдено');
			await this.conversations.authorize(
				value.conversationId,
				actor,
				actor.roles.some(role => ['ADMIN', 'DEV'].includes(role))
			);
		}
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 30000);
		const close = () => abort.abort();
		response.once('close', close);
		try {
			const stream = await this.storage.get(
				value.storageKey,
				abort.signal
			);
			response.setHeader('Cache-Control', 'private, no-store');
			response.setHeader('X-Content-Type-Options', 'nosniff');
			response.setHeader('Content-Type', value.mediaType);
			response.setHeader('Content-Length', value.byteSize);
			response.setHeader(
				'Content-Disposition',
				`inline; filename="screenshot"; filename*=UTF-8''${encodeURIComponent(value.fileName)}`
			);
			await pipeline(stream, response, { signal: abort.signal });
		} catch (error) {
			if (!response.headersSent) throw error;
			if (!response.destroyed) response.destroy();
		} finally {
			clearTimeout(timer);
			response.off('close', close);
		}
	}
	async cleanup(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			// Short bounded maintenance only; attached files and command proofs have no TTL.
			await this.prisma.$executeRaw(
				Prisma.sql`DELETE FROM support.web_rate_buckets WHERE key IN(SELECT key FROM support.web_rate_buckets WHERE expires_at<now() LIMIT 1000)`
			);
			for (let i = 0; i < 20; i++) {
				const now = new Date();
				const eligible: Prisma.SupportAttachmentWhereInput = {
					messageId: null,
					OR: [
						{
							status: { in: ['PREPARED', 'TEMPORARY', 'DELETE_PENDING'] },
							expiresAt: { lte: now }
						},
						{ status: 'DELETING', leaseExpiresAt: { lte: now } }
					]
				};
				const value = await this.prisma.supportAttachment.findFirst({
					where: eligible,
					orderBy: { expiresAt: 'asc' }
				});
				if (!value) break;
				const token = randomUUID();
				const claimed = await this.prisma.supportAttachment.updateMany({
					where: { id: value.id, ...eligible },
					data: {
						status: 'DELETING',
						leaseToken: token,
						leaseExpiresAt: new Date(Date.now() + 30000),
						attempts: { increment: 1 }
					}
				});
				if (claimed.count !== 1) continue;
				try {
					await this.storage.delete(value.storageKey);
					await this.prisma.supportAttachment.updateMany({
						where: { id: value.id, status: 'DELETING', leaseToken: token },
						data: {
							status:
								value.deletePasses < 1 ? 'DELETE_PENDING' : 'DELETED',
							deletePasses: { increment: 1 },
							leaseToken: null,
							leaseExpiresAt: null,
							expiresAt: new Date(Date.now() + 60000)
						}
					});
				} catch {
					await this.prisma.supportAttachment.updateMany({
						where: { id: value.id, status: 'DELETING', leaseToken: token },
						data: {
							status: 'DELETE_PENDING',
							leaseToken: null,
							leaseExpiresAt: null,
							expiresAt: new Date(
								Date.now() +
									Math.min(
										900000,
										1000 * 2 ** Math.min(value.attempts, 10)
									)
							)
						}
					});
				}
			}
		} finally {
			this.running = false;
		}
	}
}
