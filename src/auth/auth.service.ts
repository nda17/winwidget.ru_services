import { AuthDto } from '@/auth/dto/auth.dto'
import { ConfirmationEmailDto } from '@/auth/dto/confirmation-email.dto'
import { PhoneLoginDto } from '@/auth/dto/phone-login.dto'
import { PhoneRegisterDto } from '@/auth/dto/phone-register.dto'
import { RestorePasswordDto } from '@/auth/dto/restore-password.dto'
import { SendPhoneCodeDto } from '@/auth/dto/send-phone-code.dto'
import { EmailService } from '@/email/email.service'
import { PrismaService } from '@/prisma.service'
import { SmsService } from '@/sms/sms.service'
import { UserService } from '@/user/user.service'
import { normalizePhone } from '@/utils/phone.util'
import {
	BadRequestException,
	Injectable,
	NotFoundException,
	UnauthorizedException
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Role, type User } from '@prisma/client'
import { compare, hash } from 'bcryptjs'
import generator from 'generate-password-ts'
import { omit } from 'lodash'

@Injectable()
export class AuthService {
	private readonly PASSWORD_SALT_ROUNDS = 10
	private readonly TOKEN_EXPIRATION_ACCESS = '1h'
	private readonly TOKEN_EXPIRATION_REFRESH = '7d'
	private readonly PHONE_CODE_EXPIRATION_MINUTES = 5
	private readonly PHONE_CODE_MAX_ATTEMPTS = 5

	constructor(
		private jwt: JwtService,
		private userService: UserService,
		private emailService: EmailService,
		private prisma: PrismaService,
		private smsService: SmsService
	) {}

	async login(dto: AuthDto) {
		const user = await this.validateUser(dto)
		return this.buildResponseObject(user)
	}

	async register(dto: AuthDto) {
		const userExists = await this.userService.getUserByEmail(dto.email)
		if (userExists) {
			throw new BadRequestException('User already exists')
		}
		const user = await this.userService.createUser(dto)

		await this.emailService.sendVerification(
			user.email!,
			`${process.env.MODE === 'production' ? process.env.PRODUCTION_HOST : process.env.DEVELOPMENT_HOST}/confirmation-email?token=${user.verificationToken}`
		)

		return this.buildResponseObject(user)
	}

	async sendPhoneCode(dto: SendPhoneCodeDto, ip?: string) {
		const phone = normalizePhone(dto.phone)
		const userExists = await this.userService.getUserByPhone(phone)

		if (userExists) {
			throw new BadRequestException('Phone already exists')
		}

		const code = this.generatePhoneCode()
		const expiresAt = new Date(
			Date.now() + this.PHONE_CODE_EXPIRATION_MINUTES * 60 * 1000
		)

		await this.prisma.phoneVerificationCode.upsert({
			where: {
				phone_purpose: {
					phone,
					purpose: 'REGISTER'
				}
			},
			update: {
				codeHash: await hash(code, this.PASSWORD_SALT_ROUNDS),
				attempts: 0,
				expiresAt
			},
			create: {
				phone,
				purpose: 'REGISTER',
				codeHash: await hash(code, this.PASSWORD_SALT_ROUNDS),
				expiresAt
			}
		})

		await this.smsService.sendVerificationCode(phone, code, ip)

		return true
	}

	async registerByPhone(dto: PhoneRegisterDto) {
		const phone = normalizePhone(dto.phone)
		const existingUser = await this.userService.getUserByPhone(phone)

		if (existingUser) {
			throw new BadRequestException('Phone already exists')
		}

		await this.validatePhoneCode(phone, dto.code)

		const user = await this.userService.createPhoneUser({
			phone,
			password: dto.password
		})

		await this.deletePhoneCode(phone)

		return this.buildResponseObject(user)
	}

	async loginByPhone(dto: PhoneLoginDto) {
		const phone = normalizePhone(dto.phone)
		const user = await this.userService.getUserByPhone(phone)

		if (!user) {
			throw new UnauthorizedException('Email or password invalid')
		}

		if (!user.isPhoneVerified) {
			throw new UnauthorizedException('Phone not verified')
		}

		const isValid = await compare(dto.password, user.password)
		if (!isValid) {
			throw new UnauthorizedException('Email or password invalid')
		}

		return this.buildResponseObject(user)
	}

	async getNewTokens(refreshToken: string) {
		const result = await this.jwt.verifyAsync<{ id: string }>(refreshToken)
		if (!result?.id) {
			throw new UnauthorizedException('Invalid refresh token')
		}

		const user = await this.userService.getUserById(result.id)
		if (!user?.hashedRefreshToken) {
			throw new UnauthorizedException('Invalid refresh token')
		}

		const isValidRefreshToken = await compare(
			refreshToken,
			user.hashedRefreshToken
		)
		if (!isValidRefreshToken) {
			throw new UnauthorizedException('Invalid refresh token')
		}

		return this.buildResponseObject(user)
	}

	async logout(refreshToken?: string) {
		if (!refreshToken) {
			return true
		}

		try {
			const result = await this.jwt.verifyAsync<{ id: string }>(refreshToken)
			if (result?.id) {
				await this.prisma.user.update({
					where: { id: result.id },
					data: { hashedRefreshToken: null }
				})
			}
		} catch {
			return true
		}

		return true
	}

	async confirmationEmail(dto: ConfirmationEmailDto) {
		const { verificationToken } = dto

		const user = await this.prisma.user.findFirst({
			where: {
				verificationToken
			}
		})

		if (!user) {
			throw new NotFoundException('Token not exists!')
		}

		await this.prisma.user.update({
			where: { id: user.id },
			data: { verificationToken: null }
		})
	}

	async restorePassword(dto: RestorePasswordDto) {
		const { email, phone } = dto
		const normalizedPhone = phone ? normalizePhone(phone) : undefined
		const user = email
			? await this.prisma.user.findUnique({ where: { email } })
			: normalizedPhone
				? await this.prisma.user.findUnique({ where: { phone: normalizedPhone } })
				: null

		if (!user) {
			throw new NotFoundException('User not found')
		}

		const newPassword = generator.generate({
			length: 6,
			uppercase: true,
			lowercase: true,
			numbers: true,
			strict: true
		})

		await this.prisma.user.update({
			where: { id: user.id },
			data: {
				password: await hash(newPassword, this.PASSWORD_SALT_ROUNDS),
				hashedRefreshToken: null
			}
		})

		if (email) {
			await this.emailService.sendNewPassword(user.email!, newPassword)
		} else if (normalizedPhone) {
			await this.smsService.sendRestorePassword(normalizedPhone, newPassword)
		}
	}

	async buildResponseObject(user: User) {
		const tokens = await this.issueTokens(user.id, user.rights)
		await this.saveRefreshToken(user.id, tokens.refreshToken)
		return { user: this.omitPassword(user), ...tokens }
	}

	private async issueTokens(userId: string, rights: Role[]) {
		const payload = { id: userId, rights }
		const accessToken = this.jwt.sign(payload, {
			expiresIn: this.TOKEN_EXPIRATION_ACCESS
		})
		const refreshToken = this.jwt.sign(payload, {
			expiresIn: this.TOKEN_EXPIRATION_REFRESH
		})
		return { accessToken, refreshToken }
	}

	private generatePhoneCode() {
		return `${Math.floor(100000 + Math.random() * 900000)}`
	}

	private async validatePhoneCode(phone: string, code: string) {
		const verificationCode = await this.prisma.phoneVerificationCode.findUnique({
			where: {
				phone_purpose: {
					phone,
					purpose: 'REGISTER'
				}
			}
		})

		if (!verificationCode || verificationCode.expiresAt.getTime() < Date.now()) {
			await this.deletePhoneCode(phone)
			throw new UnauthorizedException('Phone verification code not found')
		}

		const isValidCode = await compare(code, verificationCode.codeHash)
		if (!isValidCode) {
			const nextAttempts = verificationCode.attempts + 1

			if (nextAttempts >= this.PHONE_CODE_MAX_ATTEMPTS) {
				await this.deletePhoneCode(phone)
			} else {
				await this.prisma.phoneVerificationCode.update({
					where: {
						phone_purpose: {
							phone,
							purpose: 'REGISTER'
						}
					},
					data: {
						attempts: nextAttempts
					}
				})
			}

			throw new UnauthorizedException('Phone verification code invalid')
		}
	}

	private async deletePhoneCode(phone: string) {
		await this.prisma.phoneVerificationCode.deleteMany({
			where: {
				phone,
				purpose: 'REGISTER'
			}
		})
	}

	private async saveRefreshToken(userId: string, refreshToken: string) {
		await this.prisma.user.update({
			where: { id: userId },
			data: {
				hashedRefreshToken: await hash(refreshToken, this.PASSWORD_SALT_ROUNDS)
			}
		})
	}

	private async validateUser(dto: AuthDto) {
		const user = await this.userService.getUserByEmail(dto.email)
		if (!user) {
			throw new UnauthorizedException('Email or password invalid')
		}
		const isValid = await compare(dto.password, user.password)
		if (!isValid) {
			throw new UnauthorizedException('Email or password invalid')
		}
		return user
	}

	private omitPassword(user: User) {
		return omit(user, ['password', 'hashedRefreshToken'])
	}
}
