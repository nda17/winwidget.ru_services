import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import {
	AuthIdentityType,
	Prisma,
	Role,
	UserStatus,
	VerificationChallengePurpose,
	VerificationChallengeType
} from '@prisma/identity-client';
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import {
	clientIp,
	normalizeEmail,
	normalizePhone,
	PASSWORD_SALT_ROUNDS,
	verificationCode
} from '../common/identity.util';
import {
	IdentityEventsService,
	publicUser
} from '../events/identity-events.service';
import {
	LifecycleRevocationError,
	type LifecycleRevocation,
	OwnerClientsService
} from '../integrations/owner-clients.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { VerificationTransportService } from '../transports/verification-transport.service';
import {
	BindEmailStartDto,
	BindEmailVerifyDto,
	BindPhoneVerifyDto,
	PhoneDto,
	UpdateProfileDto,
	UpdateUserDto
} from '../auth/auth.dto';

const USER_INCLUDE = {
	authIdentities: true,
	telegramNotificationChannel: true
} satisfies Prisma.UserInclude;

@Injectable()
export class UsersService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly events: IdentityEventsService,
		private readonly transport: VerificationTransportService,
		private readonly owners: OwnerClientsService
	) {}

	findById(id: string) {
		return this.prisma.user.findUnique({
			where: { id },
			include: USER_INCLUDE
		});
	}

	findByIdentity(type: AuthIdentityType, value: string) {
		return this.prisma.user.findFirst({
			where: { authIdentities: { some: { type, value } } },
			include: USER_INCLUDE
		});
	}

	async profile(id: string) {
		const user = await this.findById(id);
		if (!user) throw new NotFoundException('User not found');
		return publicUser(user);
	}

	async updateProfile(
		userId: string,
		currentSessionId: string,
		dto: UpdateProfileDto,
		request?: Request
	) {
		const passwordHash = dto.password
			? await hash(dto.password, PASSWORD_SALT_ROUNDS)
			: undefined;
		return this.prisma.$transaction(async transaction => {
			await transaction.user.update({
				where: { id: userId },
				data: {
					...(dto.name !== undefined ? { name: dto.name } : {}),
					...(dto.avatarPath !== undefined
						? { avatarPath: dto.avatarPath }
						: {}),
					...(passwordHash ? { password: passwordHash } : {})
				}
			});
			if (passwordHash) {
				await transaction.userSession.updateMany({
					where: {
						userId,
						id: { not: currentSessionId },
						revokedAt: null
					},
					data: { revokedAt: new Date() }
				});
			}
			await this.events.emitUserChanged(
				transaction,
				userId,
				request?.header('x-correlation-id')
			);
			return true;
		});
	}

	startEmailBinding(userId: string, dto: BindEmailStartDto) {
		return this.startBinding(
			userId,
			VerificationChallengeType.EMAIL,
			normalizeEmail(dto.email)
		);
	}

	async verifyEmailBinding(userId: string, dto: BindEmailVerifyDto) {
		return this.verifyBinding(
			userId,
			VerificationChallengeType.EMAIL,
			AuthIdentityType.EMAIL,
			normalizeEmail(dto.email),
			dto.code
		);
	}

	startPhoneBinding(userId: string, dto: PhoneDto) {
		return this.startBinding(
			userId,
			VerificationChallengeType.PHONE,
			normalizePhone(dto.phone)
		);
	}

	verifyPhoneBinding(userId: string, dto: BindPhoneVerifyDto) {
		return this.verifyBinding(
			userId,
			VerificationChallengeType.PHONE,
			AuthIdentityType.PHONE,
			normalizePhone(dto.phone),
			dto.code
		);
	}

	async startTelegramIdentityBinding(userId: string) {
		const username = this.telegramUsername('TELEGRAM_AUTH_BOT_USERNAME');
		const requestId = randomUUID();
		const expiresAt = new Date(Date.now() + 15 * 60_000);
		await this.prisma.verificationChallenge.upsert({
			where: {
				userId_type_purpose: {
					userId,
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.BIND_IDENTITY
				}
			},
			create: {
				userId,
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_IDENTITY,
				value: requestId,
				codeHash: await hash(requestId, PASSWORD_SALT_ROUNDS),
				expiresAt
			},
			update: {
				value: requestId,
				codeHash: await hash(requestId, PASSWORD_SALT_ROUNDS),
				attempts: 0,
				expiresAt,
				telegramUserId: null,
				telegramChatId: null
			}
		});
		return this.telegramStartResponse(requestId, username, expiresAt);
	}

	async cancelTelegramIdentityBinding(userId: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				userId,
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_IDENTITY
			}
		});
		return { cancelled: true as const };
	}

	async deleteTelegramIdentity(userId: string) {
		return this.prisma.$transaction(async transaction => {
			const user = await transaction.user.findUnique({
				where: { id: userId },
				include: USER_INCLUDE
			});
			if (!user) throw new NotFoundException('User not found');
			const hasTelegram = user.authIdentities.some(
				identity => identity.type === AuthIdentityType.TELEGRAM
			);
			if (!hasTelegram) return publicUser(user);
			const hasAnotherLoginMethod = user.authIdentities.some(identity => {
				if (identity.type === AuthIdentityType.TELEGRAM) return false;
				if (identity.type === AuthIdentityType.PHONE)
					return Boolean(identity.verifiedAt);
				return Boolean(identity.value.trim());
			});
			if (!hasAnotherLoginMethod) {
				throw new BadRequestException(
					'Нельзя удалить последний способ входа'
				);
			}
			await transaction.authIdentity.deleteMany({
				where: { userId, type: AuthIdentityType.TELEGRAM }
			});
			await transaction.verificationChallenge.deleteMany({
				where: {
					userId,
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.BIND_IDENTITY
				}
			});
			await this.events.emitUserChanged(transaction, userId);
			const updated = await transaction.user.findUniqueOrThrow({
				where: { id: userId },
				include: USER_INCLUDE
			});
			return publicUser(updated);
		});
	}

	async telegramNotificationStatus(userId: string) {
		const [channel, pending] = await Promise.all([
			this.prisma.telegramNotificationChannel.findUnique({
				where: { userId }
			}),
			this.prisma.verificationChallenge.findUnique({
				where: {
					userId_type_purpose: {
						userId,
						type: VerificationChallengeType.TELEGRAM,
						purpose:
							VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS
					}
				}
			})
		]);
		const username = this.optionalTelegramUsername(
			'TELEGRAM_INFO_BOT_USERNAME'
		);
		return {
			connected: Boolean(channel?.isActive),
			username: channel?.username || null,
			connectedAt:
				channel?.isActive && channel.connectedAt
					? channel.connectedAt.toISOString()
					: null,
			disabledAt: channel?.disabledAt?.toISOString() || null,
			telegramBotTokenConfigured: Boolean(
				process.env.TELEGRAM_INFO_BOT_TOKEN?.trim()
			),
			telegramBotUsernameConfigured: Boolean(username),
			pendingRequest:
				pending && pending.expiresAt > new Date() && username
					? this.telegramStartResponse(
							pending.value,
							username,
							pending.expiresAt
						)
					: null
		};
	}

	async startTelegramNotifications(userId: string) {
		const username = this.telegramUsername('TELEGRAM_INFO_BOT_USERNAME');
		if (!process.env.TELEGRAM_INFO_BOT_TOKEN?.trim()) {
			throw new BadRequestException(
				'Telegram notification bot is not configured'
			);
		}
		const requestId = randomUUID();
		const expiresAt = new Date(Date.now() + 15 * 60_000);
		await this.prisma.verificationChallenge.upsert({
			where: {
				userId_type_purpose: {
					userId,
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS
				}
			},
			create: {
				userId,
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS,
				value: requestId,
				codeHash: await hash(requestId, PASSWORD_SALT_ROUNDS),
				expiresAt
			},
			update: {
				value: requestId,
				codeHash: await hash(requestId, PASSWORD_SALT_ROUNDS),
				attempts: 0,
				expiresAt,
				telegramUserId: null,
				telegramChatId: null,
				telegramUsername: null,
				telegramFirstName: null,
				telegramLastName: null
			}
		});
		return this.telegramStartResponse(requestId, username, expiresAt);
	}

	async cancelTelegramNotifications(userId: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				userId,
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS
			}
		});
		return { cancelled: true as const };
	}

	async deleteTelegramNotifications(userId: string) {
		await this.prisma.$transaction(async transaction => {
			await transaction.telegramNotificationChannel.updateMany({
				where: { userId },
				data: { isActive: false, disabledAt: new Date() }
			});
			await transaction.verificationChallenge.deleteMany({
				where: {
					userId,
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS
				}
			});
			await this.events.emitUserChanged(transaction, userId);
		});
		return { disconnected: true as const };
	}

	async list(input: {
		page?: number;
		limit?: number;
		searchTerm?: string;
		role?: string;
		registeredFrom?: string;
		registeredTo?: string;
		subscription?: string;
		includeDeleted?: boolean;
		deletedOnly?: boolean;
		adminRights?: Role[];
	}) {
		const page =
			Number.isSafeInteger(input.page) && Number(input.page) > 0
				? Number(input.page)
				: 1;
		const limit =
			Number.isSafeInteger(input.limit) && Number(input.limit) > 0
				? Math.min(100, Number(input.limit))
				: 20;
		const search = input.searchTerm?.trim();
		if (
			(input.includeDeleted || input.deletedOnly) &&
			!input.adminRights?.includes(Role.DEV)
		) {
			throw new ForbiddenException(
				'Удалённых пользователей может просматривать только DEV'
			);
		}
		const role = this.normalizeRoleFilter(input.role);
		const createdAt = this.dateRange(
			input.registeredFrom,
			input.registeredTo
		);
		const subscription = input.subscription?.trim().toUpperCase();
		if (subscription && !['HAS', 'NONE'].includes(subscription)) {
			throw new BadRequestException('Некорректный фильтр подписки');
		}
		const subscriptionUserIds = subscription
			? await this.owners.subscriptionUserIds()
			: null;
		const where: Prisma.UserWhereInput = {
			...(input.deletedOnly
				? { deletedAt: { not: null } }
				: input.includeDeleted
					? {}
					: { deletedAt: null }),
			...(role
				? role === Role.USER
					? {
							AND: [
								{ rights: { has: Role.USER } },
								{ NOT: { rights: { has: Role.ADMIN } } }
							]
						}
					: { rights: { has: role } }
				: {}),
			...(createdAt ? { createdAt } : {}),
			...(subscription === 'HAS'
				? { id: { in: subscriptionUserIds || [] } }
				: subscription === 'NONE'
					? { id: { notIn: subscriptionUserIds || [] } }
					: {}),
			...(search
				? {
						OR: [
							{ name: { contains: search, mode: 'insensitive' } },
							{
								authIdentities: {
									some: {
										type: {
											in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
										},
										value: { contains: search, mode: 'insensitive' }
									}
								}
							}
						]
					}
				: {})
		};
		const [items, total] = await this.prisma.$transaction([
			this.prisma.user.findMany({
				where,
				include: USER_INCLUDE,
				orderBy: { createdAt: 'desc' },
				skip: (page - 1) * limit,
				take: limit
			}),
			this.prisma.user.count({ where })
		]);
		return {
			items: items.map(publicUser),
			total,
			page,
			limit,
			totalPages: Math.max(1, Math.ceil(total / limit))
		};
	}

	async adminGet(id: string) {
		const user = await this.findById(id);
		if (!user) throw new NotFoundException('User not found');
		if (user.deletedAt) {
			throw new BadRequestException('Пользователь уже удалён');
		}
		return publicUser(user);
	}

	async adminOverview(id: string) {
		await this.adminGet(id);
		const [billingValue, widgetsValue, auditValue] = await Promise.all([
			this.owners.billingOverview(id),
			this.owners.widgetsOverview(id),
			this.owners.adminOverview(id)
		]);
		const billing = this.remoteRecord(billingValue, 'Billing');
		const widgets = this.remoteRecord(widgetsValue, 'Widgets');
		const audit = this.remoteRecord(auditValue, 'Core');
		const counts = this.remoteRecord(billing.paymentCounts, 'Billing');
		const pending = this.remoteCount(counts.PENDING, 'Billing');
		const succeeded = this.remoteCount(counts.SUCCEEDED, 'Billing');
		const cancelled = this.remoteCount(counts.CANCELLED, 'Billing');
		this.remoteCount(counts.EXPIRED, 'Billing');
		if (!Array.isArray(billing.latestPayments)) {
			throw new ServiceUnavailableException(
				'Billing returned invalid admin overview'
			);
		}
		const usage = this.remoteRecord(widgets.usage, 'Widgets');
		const leadCount = this.remoteCount(usage.leadCount, 'Widgets');
		if (!this.isNullableRecord(billing.subscription)) {
			throw new ServiceUnavailableException(
				'Billing returned invalid admin overview'
			);
		}
		if (!this.isRecord(widgets.widgets) || !this.isRecord(widgets.leads)) {
			throw new ServiceUnavailableException(
				'Widgets returned invalid admin overview'
			);
		}
		if (!Array.isArray(audit.latest)) {
			throw new ServiceUnavailableException(
				'Core returned invalid admin overview'
			);
		}
		return {
			subscription: billing.subscription
				? { ...billing.subscription, leadsThisPeriod: leadCount }
				: null,
			payments: {
				total: pending + succeeded + cancelled,
				counts,
				latest: billing.latestPayments
			},
			widgets: widgets.widgets,
			leads: widgets.leads,
			activity: { latest: audit.latest }
		};
	}

	async adminUpdate(
		actorId: string,
		actorRights: Role[],
		id: string,
		dto: UpdateUserDto,
		request: Request
	) {
		const passwordHash = dto.password
			? await hash(dto.password, PASSWORD_SALT_ROUNDS)
			: undefined;
		return this.prisma.$transaction(
			async transaction => {
				const target = await transaction.user.findUnique({
					where: { id },
					include: USER_INCLUDE
				});
				if (!target) throw new NotFoundException('User not found');
				if (target.deletedAt) {
					throw new BadRequestException('Пользователь уже удалён');
				}
				const rights = this.roles(dto, target.rights, actorRights);
				if (!rights.length)
					throw new BadRequestException('User must have a role');
				if (
					target.rights.includes(Role.DEV) &&
					!rights.includes(Role.DEV)
				) {
					if (id === actorId) {
						throw new ForbiddenException(
							'Нельзя снять роль DEV с собственной учётной записи'
						);
					}
					await this.assertAnotherDev(transaction, id);
				}
				await transaction.user.update({
					where: { id },
					data: {
						name: typeof dto.name === 'string' ? dto.name : target.name,
						avatarPath:
							dto.avatarPath === null
								? null
								: typeof dto.avatarPath === 'string' &&
									  dto.avatarPath.length
									? dto.avatarPath
									: target.avatarPath,
						rights,
						...(passwordHash ? { password: passwordHash } : {})
					}
				});
				await this.upsertAdminIdentity(
					transaction,
					id,
					AuthIdentityType.EMAIL,
					dto.email,
					true
				);
				await this.upsertAdminIdentity(
					transaction,
					id,
					AuthIdentityType.PHONE,
					dto.phone === undefined ? undefined : normalizePhone(dto.phone),
					dto.isPhoneVerified || false
				);
				if (passwordHash) {
					await transaction.userSession.updateMany({
						where: { userId: id, revokedAt: null },
						data: { revokedAt: new Date() }
					});
				}
				await this.events.emitUserChanged(
					transaction,
					id,
					request.header('x-correlation-id')
				);
				await this.events.emitAudit(transaction, {
					actorId,
					action: 'USER_UPDATE',
					entityType: 'user',
					entityId: id,
					entityLabel: target.name || id,
					targetUserId: id,
					description: 'Обновлён пользователь',
					metadata: {
						changedFields: Object.keys(dto),
						passwordChanged: Boolean(passwordHash)
					},
					requestId: request.header('x-request-id'),
					requestIp: clientIp(request),
					requestUserAgent: request.get('user-agent')?.slice(0, 500),
					correlationId: request.header('x-correlation-id')
				});
				const updated = await transaction.user.findUniqueOrThrow({
					where: { id },
					include: USER_INCLUDE
				});
				return publicUser(updated);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	async toggleActivation(
		actorId: string,
		actorRights: Role[],
		id: string,
		request: Request
	) {
		const target = await this.prisma.user.findUnique({ where: { id } });
		if (!target) throw new NotFoundException('User not found');
		if (target.deletedAt) {
			throw new BadRequestException('Пользователь уже удалён');
		}
		if (
			target.rights.includes(Role.DEV) &&
			!actorRights.includes(Role.DEV)
		) {
			throw new ForbiddenException(
				'Изменять пользователя с ролью DEV может только DEV'
			);
		}
		if (id === actorId && target.status === UserStatus.ACTIVE) {
			throw new ForbiddenException(
				'Нельзя деактивировать собственную учётную запись'
			);
		}
		const deactivating = target.status === UserStatus.ACTIVE;
		if (deactivating && target.rights.includes(Role.DEV)) {
			await this.assertAnotherDev(
				this.prisma,
				id,
				'Нельзя деактивировать последнюю активную DEV-учётную запись',
				true
			);
		}
		let revocation: LifecycleRevocation | undefined;
		if (deactivating) {
			try {
				revocation = await this.owners.revokeEntitlements({
					userId: id,
					reason: 'USER_DEACTIVATION',
					actorId,
					actorRole: actorRights.includes(Role.DEV) ? 'DEV' : 'ADMIN'
				});
			} catch (error) {
				await this.repairIndeterminateRevocation(error);
			}
		}
		try {
			return await this.lifecycleMutation(
				actorId,
				id,
				deactivating ? 'DEACTIVATE' : 'ACTIVATE',
				request
			);
		} catch (error) {
			if (revocation) await this.recordLifecycleRepair(revocation);
			throw error;
		}
	}

	async softDelete(
		actorId: string,
		actorRights: Role[],
		id: string,
		request: Request
	) {
		if (id === actorId)
			throw new ForbiddenException(
				'Нельзя удалить собственную учётную запись'
			);
		const target = await this.prisma.user.findUnique({ where: { id } });
		if (!target) throw new NotFoundException('User not found');
		if (target.deletedAt) {
			throw new BadRequestException('Пользователь уже удалён');
		}
		if (
			target.rights.includes(Role.DEV) &&
			!actorRights.includes(Role.DEV)
		) {
			throw new ForbiddenException(
				'Удалить пользователя с ролью DEV может только DEV'
			);
		}
		if (
			target.rights.includes(Role.DEV) &&
			target.status === UserStatus.ACTIVE
		) {
			await this.assertAnotherDev(
				this.prisma,
				id,
				'Нельзя удалить последнего активного DEV',
				true
			);
		}
		let revocation: LifecycleRevocation;
		try {
			revocation = await this.owners.revokeEntitlements({
				userId: id,
				reason: 'USER_SOFT_DELETE',
				actorId,
				actorRole: actorRights.includes(Role.DEV) ? 'DEV' : 'ADMIN'
			});
		} catch (error) {
			await this.repairIndeterminateRevocation(error);
		}
		try {
			return await this.lifecycleMutation(actorId, id, 'DELETE', request);
		} catch (error) {
			await this.recordLifecycleRepair(revocation!);
			throw error;
		}
	}

	async restore(actorId: string, id: string, request: Request) {
		const target = await this.prisma.user.findUnique({
			where: { id },
			select: { deletedAt: true }
		});
		if (!target) throw new NotFoundException('User not found');
		if (!target.deletedAt) {
			throw new BadRequestException('Пользователь не удалён');
		}
		return this.lifecycleMutation(actorId, id, 'RESTORE', request);
	}

	private async startBinding(
		userId: string,
		type: VerificationChallengeType,
		value: string
	) {
		const identityType =
			type === VerificationChallengeType.EMAIL
				? AuthIdentityType.EMAIL
				: AuthIdentityType.PHONE;
		const occupied = await this.prisma.authIdentity.findFirst({
			where: { type: identityType, value, userId: { not: userId } }
		});
		if (occupied) throw new BadRequestException('Identity already exists');
		const existing = await this.prisma.verificationChallenge.findUnique({
			where: {
				userId_type_purpose: {
					userId,
					type,
					purpose: VerificationChallengePurpose.BIND_IDENTITY
				}
			}
		});
		if (existing && existing.lastSentAt.getTime() + 60_000 > Date.now()) {
			throw new BadRequestException(
				type === VerificationChallengeType.PHONE
					? 'Phone verification resend cooldown'
					: 'Email verification resend cooldown'
			);
		}
		const code = verificationCode();
		const now = new Date();
		const expiresAt = new Date(
			now.getTime() +
				(type === VerificationChallengeType.PHONE ? 5 : 10) * 60_000
		);
		const resendAvailableAt = new Date(now.getTime() + 60_000);
		const codeHash = await hash(code, PASSWORD_SALT_ROUNDS);
		await this.prisma.verificationChallenge.upsert({
			where: {
				userId_type_purpose: {
					userId,
					type,
					purpose: VerificationChallengePurpose.BIND_IDENTITY
				}
			},
			create: {
				userId,
				type,
				purpose: VerificationChallengePurpose.BIND_IDENTITY,
				value,
				codeHash,
				expiresAt,
				lastSentAt: now
			},
			update: {
				value,
				codeHash,
				attempts: 0,
				expiresAt,
				lastSentAt: now
			}
		});
		if (type === VerificationChallengeType.EMAIL) {
			await this.transport.emailCode(value, code);
		} else {
			await this.transport.smsCode(value, code);
		}
		return { value, expiresAt, resendAvailableAt };
	}

	private async verifyBinding(
		userId: string,
		type: VerificationChallengeType,
		identityType: AuthIdentityType,
		value: string,
		code: string
	) {
		const challenge = await this.prisma.verificationChallenge.findUnique({
			where: {
				userId_type_purpose: {
					userId,
					type,
					purpose: VerificationChallengePurpose.BIND_IDENTITY
				}
			}
		});
		if (!challenge || challenge.value !== value) {
			if (challenge) {
				await this.prisma.verificationChallenge.deleteMany({
					where: { id: challenge.id }
				});
			}
			throw new UnauthorizedException(
				this.bindingCodeError(type, 'not found')
			);
		}
		if (challenge.expiresAt <= new Date()) {
			await this.prisma.verificationChallenge.deleteMany({
				where: { id: challenge.id }
			});
			throw new UnauthorizedException(
				this.bindingCodeError(type, 'not found')
			);
		}
		if (challenge.attempts >= 5) {
			await this.prisma.verificationChallenge.deleteMany({
				where: { id: challenge.id }
			});
			throw new UnauthorizedException(
				this.bindingCodeError(type, 'attempts exceeded')
			);
		}
		if (!(await compare(code, challenge.codeHash))) {
			const nextAttempts = challenge.attempts + 1;
			if (nextAttempts >= 5) {
				await this.prisma.verificationChallenge.deleteMany({
					where: {
						id: challenge.id,
						attempts: challenge.attempts,
						codeHash: challenge.codeHash
					}
				});
				throw new UnauthorizedException(
					this.bindingCodeError(type, 'attempts exceeded')
				);
			}
			const changed = await this.prisma.verificationChallenge.updateMany({
				where: {
					id: challenge.id,
					attempts: challenge.attempts,
					codeHash: challenge.codeHash,
					expiresAt: { gt: new Date() }
				},
				data: { attempts: nextAttempts }
			});
			throw new UnauthorizedException(
				this.bindingCodeError(
					type,
					changed.count === 1 ? 'invalid' : 'not found'
				)
			);
		}
		return this.prisma.$transaction(async transaction => {
			const consumed = await transaction.verificationChallenge.deleteMany({
				where: {
					id: challenge.id,
					value,
					attempts: challenge.attempts,
					expiresAt: { gt: new Date() }
				}
			});
			if (consumed.count !== 1) {
				throw new UnauthorizedException('Invalid verification code');
			}
			await transaction.authIdentity.upsert({
				where: { userId_type: { userId, type: identityType } },
				create: {
					userId,
					type: identityType,
					value,
					verifiedAt: new Date()
				},
				update: { value, verifiedAt: new Date() }
			});
			await this.events.emitUserChanged(transaction, userId);
			const user = await transaction.user.findUniqueOrThrow({
				where: { id: userId },
				include: USER_INCLUDE
			});
			return publicUser(user);
		});
	}

	private roles(
		dto: UpdateUserDto,
		current: Role[],
		actorRights: Role[]
	): Role[] {
		if (
			dto.isUser === undefined &&
			dto.isAdmin === undefined &&
			dto.isDev === undefined
		) {
			return current;
		}
		const currentDev = current.includes(Role.DEV);
		const nextDev = dto.isDev ?? currentDev;
		if (nextDev !== currentDev && !actorRights.includes(Role.DEV)) {
			throw new ForbiddenException('Роль DEV может менять только DEV');
		}
		const nextAdmin =
			nextDev || (dto.isAdmin ?? current.includes(Role.ADMIN));
		return [
			Role.USER,
			...(nextAdmin ? [Role.ADMIN] : []),
			...(nextDev ? [Role.DEV] : [])
		];
	}

	private async upsertAdminIdentity(
		transaction: Prisma.TransactionClient,
		userId: string,
		type: AuthIdentityType,
		value: string | undefined,
		verified: boolean
	) {
		if (value === undefined) return;
		const normalized =
			type === AuthIdentityType.EMAIL ? normalizeEmail(value) : value;
		if (!normalized) {
			await transaction.authIdentity.deleteMany({
				where: { userId, type }
			});
			return;
		}
		await transaction.authIdentity.upsert({
			where: { userId_type: { userId, type } },
			create: {
				userId,
				type,
				value: normalized,
				verifiedAt: verified ? new Date() : null
			},
			update: {
				value: normalized,
				verifiedAt: verified ? new Date() : null
			}
		});
	}

	private async assertAnotherDev(
		transaction: Prisma.TransactionClient | IdentityPrismaService,
		id: string,
		message = 'Нельзя изменить последнюю активную DEV-учётную запись',
		forbidden = false
	) {
		const count = await transaction.user.count({
			where: {
				id: { not: id },
				status: UserStatus.ACTIVE,
				deletedAt: null,
				rights: { has: Role.DEV }
			}
		});
		if (!count) {
			if (forbidden) throw new ForbiddenException(message);
			throw new ConflictException(message);
		}
	}

	private async lifecycleMutation(
		actorId: string,
		id: string,
		operation: 'ACTIVATE' | 'DEACTIVATE' | 'DELETE' | 'RESTORE',
		request: Request
	) {
		return this.prisma.$transaction(
			async transaction => {
				const target = await transaction.user.findUnique({
					where: { id },
					include: USER_INCLUDE
				});
				if (!target) throw new NotFoundException('User not found');
				if (operation === 'RESTORE' && !target.deletedAt) {
					throw new BadRequestException('Пользователь не удалён');
				}
				if (operation !== 'RESTORE' && target.deletedAt) {
					throw new BadRequestException('Пользователь уже удалён');
				}
				if (
					(operation === 'DEACTIVATE' || operation === 'DELETE') &&
					target.rights.includes(Role.DEV) &&
					target.status === UserStatus.ACTIVE
				) {
					await this.assertAnotherDev(
						transaction,
						id,
						operation === 'DELETE'
							? 'Нельзя удалить последнего активного DEV'
							: 'Нельзя деактивировать последнюю активную DEV-учётную запись',
						true
					);
				}
				const now = new Date();
				await transaction.user.update({
					where: { id },
					data:
						operation === 'ACTIVATE'
							? {
									status: UserStatus.ACTIVE,
									personalDataConsentRevokedAt: null
								}
							: operation === 'RESTORE'
								? { deletedAt: null, status: UserStatus.DEACTIVATED }
								: {
										status: UserStatus.DEACTIVATED,
										personalDataConsentRevokedAt:
											target.personalDataConsentRevokedAt || now,
										...(operation === 'DELETE' ? { deletedAt: now } : {})
									}
				});
				if (operation === 'DEACTIVATE' || operation === 'DELETE') {
					await transaction.userSession.updateMany({
						where: { userId: id, revokedAt: null },
						data: { revokedAt: now }
					});
				}
				await this.events.emitUserChanged(
					transaction,
					id,
					request.header('x-correlation-id')
				);
				await this.events.emitAudit(transaction, {
					actorId,
					action:
						operation === 'ACTIVATE' || operation === 'DEACTIVATE'
							? 'USER_TOGGLE_ACTIVATION'
							: operation === 'DELETE'
								? 'USER_SOFT_DELETE'
								: 'USER_RESTORE',
					entityType: 'user',
					entityId: id,
					entityLabel: target.name || id,
					targetUserId: id,
					description: `Identity user lifecycle ${operation}`,
					metadata: { operation },
					requestId: request.header('x-request-id'),
					requestIp: clientIp(request),
					requestUserAgent: request.get('user-agent')?.slice(0, 500),
					correlationId: request.header('x-correlation-id')
				});
				const updated = await transaction.user.findUniqueOrThrow({
					where: { id },
					include: USER_INCLUDE
				});
				return publicUser(updated);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private async repairIndeterminateRevocation(
		error: unknown
	): Promise<never> {
		if (!(error instanceof LifecycleRevocationError)) throw error;
		await this.recordLifecycleRepair(error.revocation);
		throw error.cause || error;
	}

	private async recordLifecycleRepair(
		revocation: LifecycleRevocation
	): Promise<void> {
		await this.prisma.$transaction(transaction =>
			this.events.emitBillingRequest(transaction, {
				eventType: 'billing.lifecycle-repair.requested.v1',
				aggregateType: 'billing.lifecycle-repair',
				aggregateId: revocation.userId,
				state: {
					commandId: revocation.commandId,
					userId: revocation.userId,
					operation: revocation.operation,
					actorId: revocation.actorId,
					actorRole: revocation.actorRole,
					coreMutationApplied: false,
					requestedAt: revocation.requestedAt
				}
			})
		);
	}

	private telegramStartResponse(
		requestId: string,
		username: string,
		expiresAt: Date
	) {
		return {
			requestId,
			botUrl: `https://t.me/${username}?start=${requestId}`,
			expiresAt: expiresAt.toISOString()
		};
	}

	private bindingCodeError(
		type: VerificationChallengeType,
		kind: 'not found' | 'invalid' | 'attempts exceeded'
	): string {
		const label =
			type === VerificationChallengeType.EMAIL ? 'Email' : 'Phone';
		return `${label} verification code ${kind}`;
	}

	private telegramUsername(name: string): string {
		const username = this.optionalTelegramUsername(name);
		if (!username) {
			throw new BadRequestException('Telegram bot is not configured');
		}
		return username;
	}

	private optionalTelegramUsername(name: string): string {
		return process.env[name]?.trim().replace(/^@/, '') || '';
	}

	private normalizeRoleFilter(value?: string): Role | undefined {
		const normalized = value?.trim().toUpperCase();
		if (!normalized) return undefined;
		if (!Object.values(Role).includes(normalized as Role)) {
			throw new BadRequestException('Некорректная роль пользователя');
		}
		return normalized as Role;
	}

	private dateRange(from?: string, to?: string) {
		const gte = this.date(from, false);
		const lte = this.date(to, true);
		return gte || lte
			? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) }
			: undefined;
	}

	private date(
		value: string | undefined,
		endOfDay: boolean
	): Date | undefined {
		const normalized = value?.trim();
		if (!normalized) return undefined;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
			throw new BadRequestException('Некорректная дата фильтра');
		}
		const date = new Date(
			`${normalized}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
		);
		if (Number.isNaN(date.getTime())) {
			throw new BadRequestException('Некорректная дата фильтра');
		}
		return date;
	}

	private remoteRecord(
		value: unknown,
		owner: string
	): Record<string, any> {
		if (!this.isRecord(value)) {
			throw new ServiceUnavailableException(
				`${owner} returned invalid admin overview`
			);
		}
		return value;
	}

	private remoteCount(value: unknown, owner: string): number {
		if (!Number.isSafeInteger(value) || Number(value) < 0) {
			throw new ServiceUnavailableException(
				`${owner} returned invalid admin overview`
			);
		}
		return Number(value);
	}

	private isRecord(value: unknown): value is Record<string, any> {
		return (
			Boolean(value) && typeof value === 'object' && !Array.isArray(value)
		);
	}

	private isNullableRecord(
		value: unknown
	): value is Record<string, any> | null {
		return value === null || this.isRecord(value);
	}
}
