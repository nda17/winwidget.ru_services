import {
	IGithubProfile,
	IGoogleProfile,
	IYandexProfile
} from '@/auth/social-media/social-media-auth.types';
import { PrismaService } from '@/prisma.service';
import { UpdateProfileDto } from '@/user/dto/update-profile.dto';
import { UpdateUserDto } from '@/user/dto/update-user.dto';
import { normalizePhone } from '@/utils/phone.util';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthIdentityType, Prisma, Role, type User } from '@prisma/client';
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
	| 'YANDEX';

export type PublicUser = Omit<User, 'password' | 'hashedRefreshToken'> & {
	email: string | null;
	phone: string | null;
	isPhoneVerified: boolean;
	loginMethods: PublicUserLoginMethod[];
};

type SocialIdentityType = 'GOOGLE' | 'GITHUB' | 'YANDEX';

@Injectable()
export class UserService {
	constructor(private prisma: PrismaService) {}

	async getUserList(searchTerm?: string) {
		const normalizedSearchTerm = searchTerm?.trim();
		const users = await this.prisma.user.findMany({
			where: normalizedSearchTerm
				? {
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
					}
				: undefined,
			orderBy: {
				createdAt: 'desc'
			},
			include: {
				authIdentities: true
			}
		});

		return users.map(user => this.toPublicUser(user));
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

	async findOrCreateSocialUser(
		profile: IGoogleProfile | IGithubProfile | IYandexProfile
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
			return socialIdentity.user;
		}

		const normalizedEmail = normalizeEmail(profile.email);
		let user = await this.getUserByEmail(normalizedEmail);

		if (!user) {
			user = await this._createSocialUser(profile, socialType);
			return user;
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

		return (await this.getUserById(user.id))!;
	}

	private async _createSocialUser(
		profile: IGoogleProfile | IGithubProfile | IYandexProfile,
		socialType: SocialIdentityType
	): Promise<UserWithAuthIdentities> {
		const email = normalizeEmail(profile.email);
		const name =
			'firstName' in profile
				? `${profile.firstName} ${profile.lastName}`
				: 'displayName' in profile
					? profile.displayName
					: profile.username;
		const picture = profile.picture || '';
		const verifiedAt = new Date();

		return this.prisma.user.create({
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
	}

	async createVerifiedEmailUser(dto: {
		email: string;
		passwordHash: string;
	}) {
		return this.prisma.user.create({
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
	}

	async createPhoneUser(dto: { phone: string; password: string }) {
		return this.prisma.user.create({
			data: {
				password: await hash(dto.password, PASSWORD_SALT_ROUNDS),
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

		await this.prisma.user.update({
			where: {
				id
			},
			data: {
				name: typeof dto?.name === 'string' ? dto.name : user.name,
				avatarPath:
					typeof dto?.avatarPath === 'string' && dto.avatarPath.length
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

	async updateUser(id: string, dto?: UpdateUserDto) {
		const user = await this.getUserById(id);

		if (!user) {
			throw new NotFoundException('User not found');
		}

		const emailIdentity = this.getIdentityByType(
			user,
			AuthIdentityType.EMAIL
		);
		const phoneIdentity = this.getIdentityByType(
			user,
			AuthIdentityType.PHONE
		);
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

		const updatedUser = await this.prisma.$transaction(async tx => {
			const updated = await tx.user.update({
				where: {
					id
				},
				data: {
					password: dto?.password
						? await hash(dto.password, PASSWORD_SALT_ROUNDS)
						: user.password,
					name: typeof dto?.name === 'string' ? dto.name : user.name,
					avatarPath:
						typeof dto?.avatarPath === 'string' && dto.avatarPath.length
							? dto.avatarPath
							: user.avatarPath,
					rights: [
						dto?.isUser ? Role.USER : null,
						dto?.isAdmin ? Role.ADMIN : null
					].filter(role => role !== null)
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
		});

		return updatedUser ? this.toPublicUser(updatedUser) : null;
	}

	async deleteUser(id: string) {
		return this.prisma.user.delete({
			where: {
				id
			}
		});
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
		profile: IGoogleProfile | IGithubProfile | IYandexProfile
	): SocialIdentityType {
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
