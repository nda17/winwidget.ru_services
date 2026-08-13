import {
	IGithubProfile,
	IGoogleProfile,
	IYandexProfile,
	IVkProfile,
	TSocialProfile
} from '@/auth/social-media/social-media-auth.types';
import { BillingRegistrationBoundaryService } from '@/billing-boundary/billing-registration-boundary.service';
import { PrismaService } from '@/prisma.service';
import { UpdateProfileDto } from '@/user/dto/update-profile.dto';
import { UpdateUserDto } from '@/user/dto/update-user.dto';
import { normalizePhone } from '@/utils/phone.util';
import { WidgetsAdminOverviewClient } from '@/widgets-internal/widgets-admin-overview.client';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	AuthIdentityType,
	PaymentStatus,
	Prisma,
	Role,
	UserStatus,
	type User
} from '@prisma/client';
import { hash } from 'bcryptjs';
import { normalizeEmail } from '@/utils/email.util';
import { PASSWORD_SALT_ROUNDS } from '@/utils/auth.constants';

export type UserWithAuthIdentities = Prisma.UserGetPayload<{
	include: {
		authIdentities: true;
	};
}>;

export type PublicUserLoginMethod =
	| 'EMAIL'
	| 'PHONE'
	| 'GOOGLE'
	| 'GITHUB'
	| 'YANDEX'
	| 'VK'
	| 'TELEGRAM';

export type PublicUser = Omit<User, 'password'> & {
	email: string | null;
	phone: string | null;
	isPhoneVerified: boolean;
	loginMethods: PublicUserLoginMethod[];
};

export interface AdminUserListFilters {
	role?: string;
	registeredFrom?: string;
	registeredTo?: string;
	subscription?: string;
	includeDeleted?: boolean;
	deletedOnly?: boolean;
}

type SocialIdentityType = 'GOOGLE' | 'GITHUB' | 'YANDEX' | 'VK';

@Injectable()
export class UserService {
	constructor(
		private prisma: PrismaService,
		private readonly widgetsOverview: WidgetsAdminOverviewClient,
		private readonly billingRegistration: BillingRegistrationBoundaryService
	) {}

	async getUserList(
		searchTerm?: string,
		page = 1,
		limit = 20,
		filters: AdminUserListFilters = {},
		adminRights: Role[] = []
	) {
		const normalizedSearchTerm = searchTerm?.trim();
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const subscriptionProjectionUserIds =
			await this.getSubscriptionProjectionUserIds(filters.subscription);
		const where = this.getAdminUserListWhere(
			normalizedSearchTerm,
			filters,
			adminRights,
			subscriptionProjectionUserIds
		);
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [users, total] = await Promise.all([
			this.prisma.user.findMany({
				where,
				orderBy: filters.deletedOnly
					? { deletedAt: 'desc' }
					: { createdAt: 'desc' },
				include: {
					authIdentities: true
				},
				skip,
				take: normalizedLimit
			}),
			this.prisma.user.count({ where })
		]);

		return {
			items: users.map(user => this.toPublicUser(user)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async getUserById(id: string) {
		return this.prisma.user.findUnique({
			where: {
				id
			},
			include: {
				authIdentities: true
			}
		});
	}

	async getPublicUserById(id: string) {
		const user = await this.getUserById(id);
		return user ? this.toPublicUser(user) : null;
	}

	async getAdminEditableUserById(id: string) {
		const user = await this.getUserById(id);

		if (!user) {
			throw new NotFoundException('User not found');
		}

		this.ensureUserIsNotDeleted(user);

		return this.toPublicUser(user);
	}

	async getAdminUserOverview(id: string) {
		const user = await this.getUserById(id);

		if (!user) {
			throw new NotFoundException('User not found');
		}

		this.ensureUserIsNotDeleted(user);

		const [billingOverview, latestActivity, widgetsOverview] =
			await Promise.all([
				this.getAdminBillingOverview(id),
				this.prisma.adminEventLog.findMany({
					where: {
						OR: [{ targetUserId: id }, { adminId: id }]
					},
					orderBy: { createdAt: 'desc' },
					take: 5,
					select: {
						id: true,
						section: true,
						action: true,
						description: true,
						entityType: true,
						entityLabel: true,
						adminName: true,
						adminEmail: true,
						targetUserId: true,
						createdAt: true
					}
				}),
				this.widgetsOverview.getOwnerOverview(id)
			]);

		return {
			subscription: billingOverview.subscription
				? {
						...billingOverview.subscription,
						leadsThisPeriod: widgetsOverview.usage.leadCount
					}
				: null,
			payments: {
				total:
					billingOverview.paymentCounts.PENDING +
					billingOverview.paymentCounts.SUCCEEDED +
					billingOverview.paymentCounts.CANCELLED,
				counts: billingOverview.paymentCounts,
				latest: billingOverview.latestPayments
			},
			...widgetsOverview,
			activity: {
				latest: latestActivity.map(item => ({
					...item,
					role: item.targetUserId === id ? 'TARGET' : 'ADMIN'
				}))
			}
		};
	}

	private async getAdminBillingOverview(userId: string) {
		const [subscription, pending, succeeded, cancelled, expired, latest] =
			await this.prisma.$transaction([
				this.prisma.billingSubscriptionReadProjection.findUnique({
					where: { userId },
					select: {
						id: true,
						userId: true,
						plan: true,
						billingPeriod: true,
						status: true,
						startsAt: true,
						expiresAt: true,
						leadsThisPeriod: true,
						periodResetsAt: true,
						createdAt: true,
						updatedAt: true
					}
				}),
				...this.getProjectionPaymentOverviewQueries(userId)
			]);
		return this.toAdminBillingOverview(
			subscription,
			pending,
			succeeded,
			cancelled,
			expired,
			latest
		);
	}

	private getProjectionPaymentOverviewQueries(userId: string) {
		return [
			this.prisma.billingPaymentReadProjection.count({
				where: { userId, status: PaymentStatus.PENDING }
			}),
			this.prisma.billingPaymentReadProjection.count({
				where: { userId, status: PaymentStatus.SUCCEEDED }
			}),
			this.prisma.billingPaymentReadProjection.count({
				where: { userId, status: PaymentStatus.CANCELLED }
			}),
			this.prisma.billingPaymentReadProjection.count({
				where: { userId, status: PaymentStatus.EXPIRED }
			}),
			this.prisma.billingPaymentReadProjection.findMany({
				where: { userId },
				orderBy: { createdAt: 'desc' as const },
				take: 5,
				select: this.paymentOverviewSelect()
			})
		] as const;
	}

	private paymentOverviewSelect() {
		return {
			id: true,
			yookassaId: true,
			status: true,
			amount: true,
			plan: true,
			billingPeriod: true,
			createdAt: true,
			updatedAt: true
		} as const;
	}

	private toAdminBillingOverview<
		TSubscription,
		TPayment extends {
			id: string;
			yookassaId: string | null;
			status: PaymentStatus;
			amount: string;
			plan: unknown;
			billingPeriod: unknown;
			createdAt: Date;
			updatedAt: Date;
		}
	>(
		subscription: TSubscription | null,
		pending: number,
		succeeded: number,
		cancelled: number,
		expired: number,
		latestPayments: TPayment[]
	) {
		return {
			subscription,
			paymentCounts: {
				[PaymentStatus.PENDING]: pending,
				[PaymentStatus.SUCCEEDED]: succeeded,
				[PaymentStatus.CANCELLED]: cancelled,
				[PaymentStatus.EXPIRED]: expired
			},
			latestPayments
		};
	}

	async getUserByEmail(email: string) {
		const normalizedEmail = normalizeEmail(email);

		return this.prisma.user.findFirst({
			where: {
				authIdentities: {
					some: {
						type: AuthIdentityType.EMAIL,
						value: {
							equals: normalizedEmail,
							mode: 'insensitive'
						}
					}
				}
			},
			include: {
				authIdentities: true
			}
		});
	}

	async getUserByPhone(phone: string) {
		const normalizedPhone = normalizePhone(phone);

		return this.prisma.user.findFirst({
			where: {
				authIdentities: {
					some: {
						type: AuthIdentityType.PHONE,
						value: normalizedPhone
					}
				}
			},
			include: {
				authIdentities: true
			}
		});
	}

	async findOrCreateSocialUser(profile: TSocialProfile) {
		const result = await this.findOrCreateSocialUserWithResult(profile);
		return result.user;
	}

	async findOrCreateSocialUserWithResult(
		profile: TSocialProfile,
		referrerId?: string
	) {
		const socialType = this.getSocialIdentityType(profile);
		const socialIdentity = await this.prisma.authIdentity.findUnique({
			where: {
				type_value: {
					type: socialType,
					value: profile.providerId
				}
			},
			include: {
				user: {
					include: {
						authIdentities: true
					}
				}
			}
		});

		if (socialIdentity?.user) {
			return {
				user: socialIdentity.user,
				isCreated: false
			};
		}

		const normalizedEmail = normalizeEmail(profile.email);
		let user = await this.getUserByEmail(normalizedEmail);

		if (!user) {
			user = await this._createSocialUser(profile, socialType, referrerId);
			return {
				user,
				isCreated: true
			};
		}

		if (user.status === UserStatus.DEACTIVATED) {
			return {
				user,
				isCreated: false
			};
		}

		await this.upsertIdentity({
			userId: user.id,
			type: socialType,
			value: profile.providerId,
			verifiedAt: new Date()
		});

		if (!this.getIdentityByType(user, AuthIdentityType.EMAIL)) {
			await this.upsertIdentity({
				userId: user.id,
				type: AuthIdentityType.EMAIL,
				value: normalizedEmail,
				verifiedAt: new Date()
			});
		}

		return {
			user: (await this.getUserById(user.id))!,
			isCreated: false
		};
	}

	private async _createSocialUser(
		profile: TSocialProfile,
		socialType: SocialIdentityType,
		referrerId?: string
	): Promise<UserWithAuthIdentities> {
		const email = normalizeEmail(profile.email);
		const name = this.getSocialProfileName(profile, socialType, email);
		const picture = profile.picture || '';
		const verifiedAt = new Date();

		return this.prisma.$transaction(async transaction => {
			const user = await transaction.user.create({
				data: {
					name,
					password: '',
					avatarPath: picture,
					authIdentities: {
						create: [
							{
								type: socialType,
								value: profile.providerId,
								verifiedAt
							},
							{
								type: AuthIdentityType.EMAIL,
								value: email,
								verifiedAt
							}
						]
					}
				},
				include: {
					authIdentities: true
				}
			});
			await this.billingRegistration.captureReferralInTransaction(
				transaction,
				{
					referrerId,
					referredUserId: user.id,
					requestedAt: user.createdAt
				}
			);
			return user;
		});
	}

	private getSocialProfileName(
		profile: TSocialProfile,
		socialType: SocialIdentityType,
		fallback: string
	) {
		if (socialType === AuthIdentityType.GOOGLE) {
			const googleProfile = profile as IGoogleProfile;
			return (
				[googleProfile.firstName, googleProfile.lastName]
					.filter(Boolean)
					.join(' ') || fallback
			);
		}

		if (socialType === AuthIdentityType.YANDEX) {
			return (profile as IYandexProfile).displayName || fallback;
		}

		if (socialType === AuthIdentityType.VK) {
			const vkProfile = profile as IVkProfile;
			return (
				[vkProfile.firstName, vkProfile.lastName]
					.filter(Boolean)
					.join(' ') || fallback
			);
		}

		return (profile as IGithubProfile).username || fallback;
	}

	async createVerifiedEmailUser(dto: {
		email: string;
		passwordHash: string;
		referrerId?: string;
	}) {
		return this.prisma.$transaction(async transaction => {
			const user = await transaction.user.create({
				data: {
					password: dto.passwordHash,
					authIdentities: {
						create: {
							type: AuthIdentityType.EMAIL,
							value: normalizeEmail(dto.email),
							verifiedAt: new Date()
						}
					}
				},
				include: {
					authIdentities: true
				}
			});
			await this.billingRegistration.captureReferralInTransaction(
				transaction,
				{
					referrerId: dto.referrerId,
					referredUserId: user.id,
					requestedAt: user.createdAt
				}
			);
			return user;
		});
	}

	async createPhoneUser(dto: {
		phone: string;
		password: string;
		referrerId?: string;
	}) {
		const password = await hash(dto.password, PASSWORD_SALT_ROUNDS);
		return this.prisma.$transaction(async transaction => {
			const user = await transaction.user.create({
				data: {
					password,
					authIdentities: {
						create: {
							type: AuthIdentityType.PHONE,
							value: normalizePhone(dto.phone),
							verifiedAt: new Date()
						}
					}
				},
				include: {
					authIdentities: true
				}
			});
			await this.billingRegistration.captureReferralInTransaction(
				transaction,
				{
					referrerId: dto.referrerId,
					referredUserId: user.id,
					requestedAt: user.createdAt
				}
			);
			return user;
		});
	}

	async updateProfile(id: string, dto?: UpdateProfileDto) {
		const user = await this.prisma.user.findUnique({
			where: {
				id
			}
		});

		if (!user) {
			throw new NotFoundException('User not found');
		}

		this.ensureUserIsNotDeleted(user);

		await this.prisma.user.update({
			where: {
				id
			},
			data: {
				name: typeof dto?.name === 'string' ? dto.name : user.name,
				avatarPath:
					dto?.avatarPath === null
						? null
						: typeof dto?.avatarPath === 'string' && dto.avatarPath.length
							? dto.avatarPath
							: user.avatarPath,
				password:
					typeof dto?.password === 'string' && dto.password.length
						? await hash(dto.password, PASSWORD_SALT_ROUNDS)
						: user.password
			}
		});

		return true;
	}

	async updateUser(
		id: string,
		dto: UpdateUserDto | undefined,
		adminId: string,
		adminRights: Role[] = []
	) {
		const user = await this.getUserById(id);

		if (!user) {
			throw new NotFoundException('User not found');
		}

		this.ensureUserIsNotDeleted(user);

		const nextEmail = this.normalizeEditableEmail(dto?.email);
		const nextPhone = this.normalizeEditablePhone(dto?.phone);

		if (nextEmail) {
			const sameEmailIdentity = await this.prisma.authIdentity.findFirst({
				where: {
					type: AuthIdentityType.EMAIL,
					value: {
						equals: nextEmail,
						mode: 'insensitive'
					}
				}
			});

			if (sameEmailIdentity && sameEmailIdentity.userId !== id) {
				throw new NotFoundException('Email busy');
			}
		}

		if (nextPhone) {
			const samePhoneIdentity = await this.prisma.authIdentity.findUnique({
				where: {
					type_value: {
						type: AuthIdentityType.PHONE,
						value: nextPhone
					}
				}
			});

			if (samePhoneIdentity && samePhoneIdentity.userId !== id) {
				throw new NotFoundException('Phone busy');
			}
		}

		let updatedUser: UserWithAuthIdentities | null;

		try {
			updatedUser = await this.prisma.$transaction(
				async tx => {
					const currentUser = await tx.user.findUnique({
						where: { id },
						include: {
							authIdentities: true
						}
					});

					if (!currentUser) {
						throw new NotFoundException('User not found');
					}

					this.ensureUserIsNotDeleted(currentUser);

					const nextRights = this.buildEditableRights(
						currentUser,
						dto,
						adminRights
					);
					const removesDevRole =
						currentUser.rights.includes(Role.DEV) &&
						!nextRights.includes(Role.DEV);

					if (removesDevRole && id === adminId) {
						throw new ForbiddenException(
							'Нельзя снять роль DEV с собственной учётной записи'
						);
					}

					if (removesDevRole && currentUser.status === UserStatus.ACTIVE) {
						await this.ensureAnotherActiveDevExists(
							tx,
							'Нельзя снять роль DEV с последней активной DEV-учётной записи'
						);
					}

					const emailIdentity = this.getIdentityByType(
						currentUser,
						AuthIdentityType.EMAIL
					);
					const phoneIdentity = this.getIdentityByType(
						currentUser,
						AuthIdentityType.PHONE
					);
					const updated = await tx.user.update({
						where: {
							id
						},
						data: {
							password: dto?.password
								? await hash(dto.password, PASSWORD_SALT_ROUNDS)
								: currentUser.password,
							name:
								typeof dto?.name === 'string'
									? dto.name
									: currentUser.name,
							avatarPath:
								dto?.avatarPath === null
									? null
									: typeof dto?.avatarPath === 'string' &&
										  dto.avatarPath.length
										? dto.avatarPath
										: currentUser.avatarPath,
							rights: nextRights
						}
					});

					const targetUserId = updated.id;

					if (nextEmail !== undefined) {
						if (nextEmail) {
							await tx.authIdentity.upsert({
								where: {
									userId_type: {
										userId: targetUserId,
										type: AuthIdentityType.EMAIL
									}
								},
								update: {
									value: nextEmail,
									verifiedAt: emailIdentity?.verifiedAt ?? new Date()
								},
								create: {
									userId: targetUserId,
									type: AuthIdentityType.EMAIL,
									value: nextEmail,
									verifiedAt: new Date()
								}
							});
						} else {
							await tx.authIdentity.deleteMany({
								where: {
									userId: targetUserId,
									type: AuthIdentityType.EMAIL
								}
							});
						}
					}

					if (
						nextPhone !== undefined ||
						typeof dto?.isPhoneVerified === 'boolean'
					) {
						const phoneValue = nextPhone ?? phoneIdentity?.value ?? null;

						if (phoneValue) {
							const isVerified =
								typeof dto?.isPhoneVerified === 'boolean'
									? dto.isPhoneVerified
									: Boolean(phoneIdentity?.verifiedAt);

							await tx.authIdentity.upsert({
								where: {
									userId_type: {
										userId: targetUserId,
										type: AuthIdentityType.PHONE
									}
								},
								update: {
									value: phoneValue,
									verifiedAt: isVerified
										? (phoneIdentity?.verifiedAt ?? new Date())
										: null
								},
								create: {
									userId: targetUserId,
									type: AuthIdentityType.PHONE,
									value: phoneValue,
									verifiedAt: isVerified ? new Date() : null
								}
							});
						} else {
							await tx.authIdentity.deleteMany({
								where: {
									userId: targetUserId,
									type: AuthIdentityType.PHONE
								}
							});
						}
					}

					return tx.user.findUnique({
						where: {
							id: targetUserId
						},
						include: {
							authIdentities: true
						}
					});
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable
				}
			);
		} catch (error) {
			if (this.isSerializableTransactionConflict(error)) {
				throw new ConflictException(
					'Данные DEV-учёток изменились параллельно. Обновите страницу и повторите действие'
				);
			}

			throw error;
		}

		return updatedUser ? this.toPublicUser(updatedUser) : null;
	}

	async deleteUser(id: string, adminId: string, adminRights: Role[]) {
		if (id === adminId) {
			throw new ForbiddenException(
				'Нельзя удалить собственную учётную запись'
			);
		}

		const deletedAt = new Date();
		await this.validateLifecyclePreconditions(
			id,
			adminId,
			adminRights,
			'DELETE'
		);
		const billingRevocation =
			await this.billingRegistration.revokeBeforeLifecycleMutation({
				userId: id,
				operation: 'DELETE',
				actorId: adminId,
				actorRights: adminRights
			});
		let deletedUser: UserWithAuthIdentities;
		try {
			deletedUser = await this.prisma.$transaction(
				async tx => {
					const user = await tx.user.findUnique({
						where: { id },
						include: {
							authIdentities: true
						}
					});

					if (!user) {
						throw new NotFoundException('User not found');
					}

					if (user.deletedAt) {
						throw new BadRequestException('Пользователь уже удалён');
					}

					const targetIsDev = user.rights.includes(Role.DEV);

					if (targetIsDev && !adminRights.includes(Role.DEV)) {
						throw new ForbiddenException(
							'Удалить пользователя с ролью DEV может только DEV'
						);
					}

					if (targetIsDev && user.status === UserStatus.ACTIVE) {
						const activeDevCount = await tx.user.count({
							where: {
								status: UserStatus.ACTIVE,
								deletedAt: null,
								rights: {
									has: Role.DEV
								}
							}
						});

						if (activeDevCount <= 1) {
							throw new ForbiddenException(
								'Нельзя удалить последнего активного DEV'
							);
						}
					}

					const updated = await tx.user.update({
						where: { id },
						data: {
							status: UserStatus.DEACTIVATED,
							personalDataConsentRevokedAt:
								user.personalDataConsentRevokedAt ?? deletedAt,
							deletedAt
						},
						include: {
							authIdentities: true
						}
					});

					await this.revokeSessionsForLifecycle(tx, id, deletedAt);

					return updated;
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable
				}
			);
		} catch (error) {
			if (billingRevocation.remoteApplied) {
				await this.billingRegistration.recordLifecycleRepair(
					billingRevocation
				);
			}
			throw error;
		}

		return this.toPublicUser(deletedUser);
	}

	async restoreUser(id: string) {
		const user = await this.prisma.user.findUnique({
			where: { id },
			include: {
				authIdentities: true
			}
		});

		if (!user) {
			throw new NotFoundException('User not found');
		}

		if (!user.deletedAt) {
			throw new BadRequestException('Пользователь не удалён');
		}

		const restoredUser = await this.prisma.user.update({
			where: { id },
			data: {
				deletedAt: null,
				status: UserStatus.DEACTIVATED
			},
			include: {
				authIdentities: true
			}
		});

		return this.toPublicUser(restoredUser);
	}

	async toggleUserActivation(
		id: string,
		adminId: string,
		adminRights: Role[]
	) {
		const user = await this.prisma.user.findUnique({
			where: { id },
			select: {
				status: true,
				deletedAt: true,
				rights: true
			}
		});

		if (!user) {
			throw new NotFoundException('User not found');
		}

		this.ensureUserIsNotDeleted(user);
		await this.validateLifecyclePreconditions(
			id,
			adminId,
			adminRights,
			user.status === UserStatus.ACTIVE ? 'DEACTIVATE' : 'ACTIVATE'
		);

		const statusChangedAt = new Date();

		let updatedUser: UserWithAuthIdentities;
		const billingRevocation =
			user.status === UserStatus.ACTIVE
				? await this.billingRegistration.revokeBeforeLifecycleMutation({
						userId: id,
						operation: 'DEACTIVATE',
						actorId: adminId,
						actorRights: adminRights
					})
				: null;

		try {
			updatedUser = await this.prisma.$transaction(
				async tx => {
					const currentUser = await tx.user.findUnique({
						where: { id },
						include: {
							authIdentities: true
						}
					});

					if (!currentUser) {
						throw new NotFoundException('User not found');
					}

					this.ensureUserIsNotDeleted(currentUser);

					const shouldDeactivate =
						currentUser.status === UserStatus.ACTIVE;
					const targetIsDev = currentUser.rights.includes(Role.DEV);

					if (targetIsDev && !adminRights.includes(Role.DEV)) {
						throw new ForbiddenException(
							'Изменять статус пользователя с ролью DEV может только DEV'
						);
					}

					if (shouldDeactivate && id === adminId) {
						throw new ForbiddenException(
							'Нельзя деактивировать собственную учётную запись'
						);
					}

					if (shouldDeactivate && targetIsDev) {
						await this.ensureAnotherActiveDevExists(
							tx,
							'Нельзя деактивировать последнюю активную DEV-учётную запись'
						);
					}

					const updateResult = await tx.user.updateMany({
						where: {
							id,
							status: currentUser.status,
							deletedAt: null
						},
						data: shouldDeactivate
							? {
									status: UserStatus.DEACTIVATED,
									personalDataConsentRevokedAt: statusChangedAt
								}
							: {
									status: UserStatus.ACTIVE,
									personalDataConsentRevokedAt: null
								}
					});

					if (updateResult.count !== 1) {
						throw new ConflictException(
							'Статус пользователя уже изменён. Обновите страницу и повторите действие'
						);
					}

					const updated = await tx.user.findUnique({
						where: { id },
						include: {
							authIdentities: true
						}
					});

					if (!updated) {
						throw new NotFoundException('User not found');
					}

					if (shouldDeactivate) {
						await this.revokeSessionsForLifecycle(tx, id, statusChangedAt);
					}

					return updated;
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable
				}
			);
		} catch (error) {
			if (billingRevocation?.remoteApplied) {
				await this.billingRegistration.recordLifecycleRepair(
					billingRevocation
				);
			}
			if (this.isSerializableTransactionConflict(error)) {
				throw new ConflictException(
					'Данные DEV-учёток изменились параллельно. Обновите страницу и повторите действие'
				);
			}
			throw error;
		}

		return this.toPublicUser(updatedUser);
	}

	private async revokeSessionsForLifecycle(
		tx: Prisma.TransactionClient,
		userId: string,
		revokedAt: Date
	) {
		await tx.userSession.updateMany({
			where: { userId, revokedAt: null },
			data: { revokedAt }
		});
	}

	private async validateLifecyclePreconditions(
		userId: string,
		actorId: string,
		actorRights: Role[],
		operation: 'ACTIVATE' | 'DEACTIVATE' | 'DELETE'
	): Promise<void> {
		const target = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { status: true, deletedAt: true, rights: true }
		});
		if (!target) throw new NotFoundException('User not found');
		if (target.deletedAt) {
			throw new BadRequestException('Пользователь уже удалён');
		}
		const targetIsDev = target.rights.includes(Role.DEV);
		if (targetIsDev && !actorRights.includes(Role.DEV)) {
			throw new ForbiddenException(
				'Изменять пользователя с ролью DEV может только DEV'
			);
		}
		if (operation !== 'ACTIVATE' && userId === actorId) {
			throw new ForbiddenException(
				'Нельзя деактивировать собственную учётную запись'
			);
		}
		if (
			operation !== 'ACTIVATE' &&
			targetIsDev &&
			target.status === UserStatus.ACTIVE
		) {
			const activeDevCount = await this.prisma.user.count({
				where: {
					status: UserStatus.ACTIVE,
					deletedAt: null,
					rights: { has: Role.DEV }
				}
			});
			if (activeDevCount <= 1) {
				throw new ForbiddenException(
					'Нельзя деактивировать последнюю активную DEV-учётную запись'
				);
			}
		}
	}

	private async ensureAnotherActiveDevExists(
		tx: Prisma.TransactionClient,
		message: string
	) {
		const activeDevCount = await tx.user.count({
			where: {
				status: UserStatus.ACTIVE,
				deletedAt: null,
				rights: {
					has: Role.DEV
				}
			}
		});

		if (activeDevCount <= 1) {
			throw new ForbiddenException(message);
		}
	}

	private isSerializableTransactionConflict(error: unknown) {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'P2034'
		);
	}

	private getAdminUserListWhere(
		normalizedSearchTerm: string | undefined,
		filters: AdminUserListFilters,
		adminRights: Role[],
		subscriptionProjectionUserIds: string[] | null = null
	): Prisma.UserWhereInput | undefined {
		const and: Prisma.UserWhereInput[] = [];
		const role = this.normalizeUserRole(filters.role);
		const subscriptionFilter = this.normalizeSubscriptionPresence(
			filters.subscription
		);
		const createdAt = this.getDateRangeFilter(
			filters.registeredFrom,
			filters.registeredTo
		);

		if (
			(filters.includeDeleted || filters.deletedOnly) &&
			!adminRights.includes(Role.DEV)
		) {
			throw new ForbiddenException(
				'Удалённых пользователей может просматривать только DEV'
			);
		}

		if (filters.deletedOnly) {
			and.push({ deletedAt: { not: null } });
		} else if (!filters.includeDeleted) {
			and.push({ deletedAt: null });
		}

		if (normalizedSearchTerm) {
			and.push({
				OR: [
					{
						name: {
							contains: normalizedSearchTerm,
							mode: 'insensitive'
						}
					},
					{
						authIdentities: {
							some: {
								type: {
									in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
								},
								value: {
									contains: normalizedSearchTerm,
									mode: 'insensitive'
								}
							}
						}
					}
				]
			});
		}

		if (role) {
			and.push(this.getRoleWhere(role));
		}

		if (createdAt) {
			and.push({ createdAt });
		}

		if (subscriptionFilter === 'HAS') {
			and.push({ id: { in: subscriptionProjectionUserIds ?? [] } });
		}

		if (subscriptionFilter === 'NONE') {
			and.push({ id: { notIn: subscriptionProjectionUserIds ?? [] } });
		}

		return and.length ? { AND: and } : undefined;
	}

	private async getSubscriptionProjectionUserIds(
		filter: string | undefined
	): Promise<string[] | null> {
		if (!this.normalizeSubscriptionPresence(filter)) return null;
		const rows =
			await this.prisma.billingSubscriptionReadProjection.findMany({
				select: { userId: true }
			});
		return rows.map(row => row.userId);
	}

	private normalizeUserRole(value?: string) {
		const normalized = value?.trim().toUpperCase();

		if (!normalized) {
			return undefined;
		}

		if (!Object.values(Role).includes(normalized as Role)) {
			throw new BadRequestException('Некорректная роль пользователя');
		}

		return normalized as Role;
	}

	private getRoleWhere(role: Role): Prisma.UserWhereInput {
		if (role !== Role.USER) {
			return {
				rights: {
					has: role
				}
			};
		}

		return {
			rights: {
				has: Role.USER
			},
			NOT: {
				rights: {
					has: Role.ADMIN
				}
			}
		};
	}

	private buildEditableRights(
		user: UserWithAuthIdentities,
		dto?: UpdateUserDto,
		adminRights: Role[] = []
	): Role[] {
		const currentIsDev = user.rights.includes(Role.DEV);
		const nextIsDev = dto?.isDev ?? currentIsDev;
		const devRoleChanged =
			typeof dto?.isDev === 'boolean' && dto.isDev !== currentIsDev;

		if (devRoleChanged && !adminRights.includes(Role.DEV)) {
			throw new ForbiddenException(
				'Роль DEV может менять только пользователь с ролью DEV'
			);
		}

		const nextIsAdmin =
			nextIsDev || (dto?.isAdmin ?? user.rights.includes(Role.ADMIN));
		const rights: Role[] = [Role.USER];

		if (nextIsAdmin) {
			rights.push(Role.ADMIN);
		}

		if (nextIsDev) {
			rights.push(Role.DEV);
		}

		return rights;
	}

	private ensureUserIsNotDeleted(user: { deletedAt: Date | null }) {
		if (user.deletedAt) {
			throw new BadRequestException(
				'Сначала восстановите удалённого пользователя'
			);
		}
	}

	private normalizeSubscriptionPresence(value?: string) {
		const normalized = value?.trim().toUpperCase();

		if (!normalized) {
			return undefined;
		}

		if (normalized !== 'HAS' && normalized !== 'NONE') {
			throw new BadRequestException('Некорректный фильтр подписки');
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

	toPublicUser(user: UserWithAuthIdentities): PublicUser {
		const emailIdentity = this.getIdentityByType(
			user,
			AuthIdentityType.EMAIL
		);
		const phoneIdentity = this.getIdentityByType(
			user,
			AuthIdentityType.PHONE
		);

		return {
			id: user.id,
			name: user.name,
			avatarPath: user.avatarPath,
			status: user.status,
			personalDataConsentRevokedAt: user.personalDataConsentRevokedAt,
			deletedAt: user.deletedAt,
			rights: user.rights,
			createdAt: user.createdAt,
			updatedAt: user.updatedAt,
			email: emailIdentity?.value ?? null,
			phone: phoneIdentity?.value ?? null,
			isPhoneVerified: Boolean(phoneIdentity?.verifiedAt),
			loginMethods: this.getLoginMethods(user)
		};
	}

	private getIdentityByType(
		user: UserWithAuthIdentities,
		type: AuthIdentityType
	) {
		return user.authIdentities.find(identity => identity.type === type);
	}

	private getLoginMethods(
		user: UserWithAuthIdentities
	): PublicUserLoginMethod[] {
		const loginMethods: PublicUserLoginMethod[] = [];
		const phoneIdentity = this.getIdentityByType(
			user,
			AuthIdentityType.PHONE
		);

		if (this.getIdentityByType(user, AuthIdentityType.EMAIL)) {
			loginMethods.push('EMAIL');
		}

		if (phoneIdentity?.verifiedAt) {
			loginMethods.push('PHONE');
		}

		if (this.getIdentityByType(user, AuthIdentityType.GOOGLE)) {
			loginMethods.push('GOOGLE');
		}

		if (this.getIdentityByType(user, AuthIdentityType.GITHUB)) {
			loginMethods.push('GITHUB');
		}

		if (this.getIdentityByType(user, AuthIdentityType.YANDEX)) {
			loginMethods.push('YANDEX');
		}

		if (this.getIdentityByType(user, AuthIdentityType.VK)) {
			loginMethods.push('VK');
		}

		if (this.getIdentityByType(user, AuthIdentityType.TELEGRAM)) {
			loginMethods.push('TELEGRAM');
		}

		return loginMethods;
	}

	private async upsertIdentity({
		userId,
		type,
		value,
		verifiedAt
	}: {
		userId: string;
		type: AuthIdentityType;
		value: string;
		verifiedAt: Date | null;
	}) {
		return this.prisma.authIdentity.upsert({
			where: {
				userId_type: {
					userId,
					type
				}
			},
			update: {
				value,
				verifiedAt
			},
			create: {
				userId,
				type,
				value,
				verifiedAt
			}
		});
	}

	private getSocialIdentityType(
		profile: TSocialProfile
	): SocialIdentityType {
		if ('provider' in profile && profile.provider === 'vk') {
			return AuthIdentityType.VK;
		}
		if ('firstName' in profile) return AuthIdentityType.GOOGLE;
		if ('displayName' in profile) return AuthIdentityType.YANDEX;
		return AuthIdentityType.GITHUB;
	}

	private normalizeEditableEmail(email?: string) {
		if (typeof email !== 'string') {
			return undefined;
		}

		const trimmedEmail = email.trim();
		return trimmedEmail ? normalizeEmail(trimmedEmail) : null;
	}

	private normalizeEditablePhone(phone?: string) {
		if (typeof phone !== 'string') {
			return undefined;
		}

		const trimmedPhone = phone.trim();
		return trimmedPhone ? normalizePhone(trimmedPhone) : null;
	}
}
