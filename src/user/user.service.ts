import { AuthDto } from '@/auth/dto/auth.dto'
import {
	IGithubProfile,
	IGoogleProfile
} from '@/auth/social-media/social-media-auth.types'
import { PrismaService } from '@/prisma.service'
import { UpdateUserDto } from '@/user/dto/update-user.dto'
import { Injectable, NotFoundException } from '@nestjs/common'
import { Role, type User } from '@prisma/client'
import { hash } from 'bcryptjs'

@Injectable()
export class UserService {
	private readonly PASSWORD_SALT_ROUNDS = 10

	constructor(private prisma: PrismaService) {}

	async getUserList(searchTerm: string) {
		return this.prisma.user.findMany({
			where: {
				OR: [
					{
						email: {
							contains: searchTerm
						}
					},
					{
						phone: {
							contains: searchTerm
						}
					},
					{
						name: {
							contains: searchTerm
						}
					}
				]
			},
			select: {
				id: true,
				name: true,
				email: true,
				phone: true,
				isPhoneVerified: true,
				verificationToken: true,
				rights: true,
				createdAt: true,
				password: false
			}
		})
	}

	async getUserById(id: string) {
		return this.prisma.user.findUnique({
			where: {
				id
			}
		})
	}

	async getUserByEmail(email: string) {
		return this.prisma.user.findUnique({
			where: {
				email
			}
		})
	}

	async getUserByPhone(phone: string) {
		return this.prisma.user.findUnique({
			where: {
				phone
			}
		})
	}

	async findOrCreateSocialUser(profile: IGoogleProfile | IGithubProfile) {
		let user = await this.getUserByEmail(profile.email)
		if (!user) {
			user = await this._createSocialUser(profile)
		}
		return user
	}

	private async _createSocialUser(
		profile: IGoogleProfile | IGithubProfile
	): Promise<User> {
		const email = profile.email
		const name =
			'firstName' in profile
				? `${profile.firstName} ${profile.lastName}`
				: profile.username
		const picture = profile.picture || ''

		return this.prisma.user.create({
			data: {
				email,
				name,
				password: '',
				verificationToken: null,
				avatarPath: picture
			}
		})
	}

	async createUser(dto: AuthDto) {
		return this.prisma.user.create({
			data: {
				...dto,
				email: dto.email.toLowerCase(),
				password: await hash(dto.password, this.PASSWORD_SALT_ROUNDS)
			}
		})
	}

	async createPhoneUser(dto: { phone: string; password: string }) {
		return this.prisma.user.create({
			data: {
				email: null,
				phone: dto.phone,
				isPhoneVerified: true,
				password: await hash(dto.password, this.PASSWORD_SALT_ROUNDS),
				verificationToken: null
			}
		})
	}

	async updateUser(id: string, dto?: UpdateUserDto) {
		const user = await this.prisma.user.findUnique({
			where: {
				id
			}
		})

		if (!user) {
			throw new NotFoundException('User not found')
		}

		const isSameUser = dto.email
			? await this.prisma.user.findFirst({
					where: {
						email: dto.email
					}
				})
			: null

		if (isSameUser && id !== isSameUser.id) {
			throw new NotFoundException('Email busy')
		}

		const isSamePhoneUser = dto.phone
			? await this.prisma.user.findFirst({
					where: {
						phone: dto.phone
					}
				})
			: null

		if (isSamePhoneUser && id !== isSamePhoneUser.id) {
			throw new NotFoundException('Phone busy')
		}

		return this.prisma.user.update({
			where: {
				id
			},
			data: {
				id: dto.id ? dto.id : user.id,
				email:
					typeof dto.email === 'string'
						? dto.email.toLowerCase()
						: user.email,
				phone: typeof dto.phone === 'string' ? dto.phone : user.phone,
				isPhoneVerified:
					typeof dto.isPhoneVerified === 'boolean'
						? dto.isPhoneVerified
						: user.isPhoneVerified,
				password: dto.password
					? await hash(dto.password, this.PASSWORD_SALT_ROUNDS)
					: user.password,
				name: dto.name,
				avatarPath: dto.avatarPath ? dto.avatarPath : user.avatarPath,
				rights: [
					dto.isUser ? Role.USER : null,
					dto.isAdmin ? Role.ADMIN : null,
					dto.isManager ? Role.MANAGER : null,
					dto.isPremium ? Role.PREMIUM : null
				].filter((role) => role !== null)
			}
		})
	}

	async deleteUser(id: string) {
		return this.prisma.user.delete({
			where: {
				id
			}
		})
	}
}
