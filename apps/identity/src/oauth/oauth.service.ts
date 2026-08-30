import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	AuthIdentityType,
	OAuthProvider,
	Prisma,
	UserStatus
} from '@prisma/identity-client';
import type { CookieOptions, Request, Response } from 'express';
import {
	normalizeEmail,
	randomToken,
	sha256,
	sha256Base64Url,
	safeEqual
} from '../common/identity.util';
import { IdentityEventsService } from '../events/identity-events.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { AuthSettingsService } from '../auth/auth-settings.service';
import { AuthService } from '../auth/auth.service';
import { RefreshTokenService } from '../auth/refresh-token.service';

type ProviderName = 'google' | 'github' | 'yandex' | 'vk';

interface SocialProfile {
	providerId: string;
	email: string;
	name?: string;
	avatarPath?: string;
}

class OAuthAccountDeactivatedError extends Error {}

const USER_INCLUDE = {
	authIdentities: true,
	telegramNotificationChannel: true
} satisfies Prisma.UserInclude;

@Injectable()
export class OAuthService {
	private readonly clientOrigin: string;

	constructor(
		private readonly config: ConfigService,
		private readonly prisma: IdentityPrismaService,
		private readonly events: IdentityEventsService,
		private readonly settings: AuthSettingsService,
		private readonly auth: AuthService,
		private readonly refreshTokens: RefreshTokenService
	) {
		this.clientOrigin = requireValue(
			config,
			'RECAPTCHA_CLIENT_URL'
		).replace(/\/$/, '');
	}

	async start(
		provider: ProviderName,
		referrerId: string | undefined,
		response: Response
	) {
		await this.settings.assertProviderEnabled(provider);
		const state = randomToken(32);
		const verifier = randomToken(48);
		await this.prisma.oAuthAuthorization.create({
			data: {
				stateHash: sha256(state),
				provider: this.enum(provider),
				codeVerifier: verifier,
				referrerId: referrerId?.trim().slice(0, 128) || null,
				expiresAt: new Date(Date.now() + 10 * 60_000)
			}
		});
		response.cookie(
			this.cookie(provider),
			state,
			this.cookieOptions(provider)
		);
		return response.redirect(
			this.authorizationUrl(provider, state, verifier)
		);
	}

	async callback(
		provider: ProviderName,
		request: Request,
		response: Response,
		input: {
			code?: string;
			state?: string;
			deviceId?: string;
			error?: string;
		}
	) {
		try {
			await this.settings.assertProviderEnabled(provider);
			if (input.error || !input.code || !input.state) {
				throw new Error('OAuth authorization was rejected');
			}
			const cookieState = request.cookies?.[this.cookie(provider)];
			if (
				typeof cookieState !== 'string' ||
				!safeEqual(cookieState, input.state)
			) {
				throw new Error('OAuth state is invalid');
			}
			const authorization = await this.consume(provider, input.state);
			const profile = await this.profile(
				provider,
				input.code,
				authorization.codeVerifier,
				input.deviceId,
				input.state
			);
			const user = await this.upsertUser(
				provider,
				profile,
				authorization.referrerId || undefined
			);
			const { refreshToken } = await this.auth.startSession(user, request);
			response.clearCookie(
				this.cookie(provider),
				this.clearCookieOptions(provider)
			);
			this.refreshTokens.add(response, refreshToken);
			return response.redirect(`${this.clientOrigin}/social-auth`);
		} catch (error) {
			response.clearCookie(
				this.cookie(provider),
				this.clearCookieOptions(provider)
			);
			this.refreshTokens.remove(response);
			const code =
				error instanceof OAuthAccountDeactivatedError
					? 'account_deactivated'
					: 'social_auth_failed';
			return response.redirect(`${this.clientOrigin}/login?error=${code}`);
		}
	}

	private async consume(provider: ProviderName, state: string) {
		return this.prisma.$transaction(async transaction => {
			const authorization =
				await transaction.oAuthAuthorization.findUnique({
					where: { stateHash: sha256(state) }
				});
			if (
				!authorization ||
				authorization.provider !== this.enum(provider) ||
				authorization.consumedAt ||
				authorization.expiresAt <= new Date()
			) {
				throw new BadRequestException('OAuth state is invalid');
			}
			const consumed = await transaction.oAuthAuthorization.updateMany({
				where: {
					stateHash: authorization.stateHash,
					consumedAt: null,
					expiresAt: { gt: new Date() }
				},
				data: { consumedAt: new Date() }
			});
			if (consumed.count !== 1)
				throw new BadRequestException('OAuth state is invalid');
			return authorization;
		});
	}

	private async upsertUser(
		provider: ProviderName,
		profile: SocialProfile,
		referrerId?: string
	) {
		const type = this.identityType(provider);
		const email = requiredEmail(profile.email);
		return this.prisma.$transaction(async transaction => {
			const providerIdentity = await transaction.authIdentity.findUnique({
				where: { type_value: { type, value: profile.providerId } },
				include: { user: { include: USER_INCLUDE } }
			});
			if (providerIdentity) {
				if (
					providerIdentity.user.status !== UserStatus.ACTIVE ||
					providerIdentity.user.deletedAt
				) {
					throw new OAuthAccountDeactivatedError();
				}
				return providerIdentity.user;
			}
			const emailIdentity = await transaction.authIdentity.findUnique({
				where: {
					type_value: { type: AuthIdentityType.EMAIL, value: email }
				},
				include: { user: { include: USER_INCLUDE } }
			});
			if (emailIdentity) {
				if (
					emailIdentity.user.status !== UserStatus.ACTIVE ||
					emailIdentity.user.deletedAt
				) {
					throw new OAuthAccountDeactivatedError();
				}
				await transaction.authIdentity.create({
					data: {
						userId: emailIdentity.userId,
						type,
						value: profile.providerId,
						verifiedAt: new Date()
					}
				});
				await this.events.emitUserChanged(
					transaction,
					emailIdentity.userId
				);
				return transaction.user.findUniqueOrThrow({
					where: { id: emailIdentity.userId },
					include: USER_INCLUDE
				});
			}
			const created = await transaction.user.create({
				data: {
					name: profile.name?.slice(0, 255) || null,
					avatarPath: profile.avatarPath?.slice(0, 2_000) || null,
					password: '',
					authIdentities: {
						create: [
							{ type, value: profile.providerId, verifiedAt: new Date() },
							{
								type: AuthIdentityType.EMAIL,
								value: email,
								verifiedAt: new Date()
							}
						]
					}
				},
				include: USER_INCLUDE
			});
			if (referrerId && referrerId !== created.id) {
				const referrer = await transaction.user.findFirst({
					where: {
						id: referrerId,
						status: UserStatus.ACTIVE,
						deletedAt: null
					}
				});
				if (referrer) {
					await this.events.emitBillingRequest(transaction, {
						eventType: 'billing.referral.requested.v1',
						aggregateType: 'billing.referral-request',
						aggregateId: created.id,
						state: {
							referrerId,
							referredUserId: created.id,
							requestedAt: new Date().toISOString()
						}
					});
				}
			}
			await this.events.emitUserChanged(transaction, created.id);
			return created;
		});
	}

	private authorizationUrl(
		provider: ProviderName,
		state: string,
		verifier: string
	) {
		const challenge = sha256Base64Url(verifier);
		const callback = this.callbackUrl(provider);
		const common = {
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256'
		};
		if (provider === 'google') {
			return url('https://accounts.google.com/o/oauth2/v2/auth', {
				...common,
				client_id: requireValue(this.config, 'GOOGLE_CLIENT_ID'),
				redirect_uri: callback,
				response_type: 'code',
				scope: 'openid email profile'
			});
		}
		if (provider === 'github') {
			return url('https://github.com/login/oauth/authorize', {
				...common,
				client_id: requireValue(this.config, 'GITHUB_CLIENT_ID'),
				redirect_uri: callback,
				scope: 'user:email'
			});
		}
		if (provider === 'yandex') {
			return url('https://oauth.yandex.ru/authorize', {
				...common,
				client_id: requireValue(this.config, 'YANDEX_CLIENT_ID'),
				redirect_uri: callback,
				response_type: 'code',
				force_confirm: 'no'
			});
		}
		return url('https://id.vk.ru/authorize', {
			...common,
			client_id: requireValue(this.config, 'VK_CLIENT_ID'),
			redirect_uri: callback,
			response_type: 'code',
			scope: 'email'
		});
	}

	private async profile(
		provider: ProviderName,
		code: string,
		verifier: string,
		deviceId?: string,
		state?: string
	): Promise<SocialProfile> {
		if (provider === 'google') {
			const accessToken = await this.exchange(
				'https://oauth2.googleapis.com/token',
				{
					grant_type: 'authorization_code',
					code,
					client_id: requireValue(this.config, 'GOOGLE_CLIENT_ID'),
					client_secret: requireValue(this.config, 'GOOGLE_CLIENT_SECRET'),
					redirect_uri: this.callbackUrl(provider),
					code_verifier: verifier
				}
			);
			const data = await json(
				'https://openidconnect.googleapis.com/v1/userinfo',
				accessToken
			);
			if (data.email_verified !== true) {
				throw new Error('Google OAuth email is not verified');
			}
			return {
				providerId: requiredString(data, 'sub'),
				email: requiredEmail(requiredString(data, 'email')),
				name: optionalString(data, 'name'),
				avatarPath: optionalString(data, 'picture')
			};
		}
		if (provider === 'github') {
			const accessToken = await this.exchange(
				'https://github.com/login/oauth/access_token',
				{
					client_id: requireValue(this.config, 'GITHUB_CLIENT_ID'),
					client_secret: requireValue(this.config, 'GITHUB_CLIENT_SECRET'),
					code,
					redirect_uri: this.callbackUrl(provider),
					code_verifier: verifier
				}
			);
			const data = await json('https://api.github.com/user', accessToken);
			const emails = await jsonArray(
				'https://api.github.com/user/emails',
				accessToken
			);
			const verifiedEmails = emails
				.filter(record)
				.filter(
					item => item.verified === true && typeof item.email === 'string'
				)
				.sort(
					(left, right) =>
						Number(right.primary === true) - Number(left.primary === true)
				);
			const email = verifiedEmails[0]?.email;
			return {
				providerId: requiredIdentifier(data, 'id'),
				email: requiredEmail(email),
				name:
					optionalString(data, 'name') || optionalString(data, 'login'),
				avatarPath: optionalString(data, 'avatar_url')
			};
		}
		if (provider === 'yandex') {
			const accessToken = await this.exchange(
				'https://oauth.yandex.ru/token',
				{
					grant_type: 'authorization_code',
					code,
					client_id: requireValue(this.config, 'YANDEX_CLIENT_ID'),
					client_secret: requireValue(this.config, 'YANDEX_CLIENT_SECRET'),
					redirect_uri: this.callbackUrl(provider),
					code_verifier: verifier
				}
			);
			const data = await json(
				'https://login.yandex.ru/info?format=json',
				accessToken,
				'OAuth'
			);
			const avatarId = optionalString(data, 'default_avatar_id');
			const avatarPath =
				data.is_avatar_empty === true || !avatarId
					? undefined
					: `https://avatars.yandex.net/get-yapic/${avatarId}/islands-200`;
			return {
				providerId: requiredString(data, 'id'),
				email: requiredEmail(requiredString(data, 'default_email')),
				name:
					optionalString(data, 'display_name') ||
					optionalString(data, 'login'),
				avatarPath
			};
		}
		if (!deviceId || !state) throw new Error('VK callback is incomplete');
		const tokenData = await formJson('https://id.vk.ru/oauth2/auth', {
			grant_type: 'authorization_code',
			client_id: requireValue(this.config, 'VK_CLIENT_ID'),
			service_token: requireValue(this.config, 'VK_SERVICE_TOKEN'),
			redirect_uri: this.callbackUrl(provider),
			code,
			code_verifier: verifier,
			device_id: deviceId,
			state
		});
		const accessToken = requiredString(tokenData, 'access_token');
		const tokenUserId = requiredIdentifier(tokenData, 'user_id');
		if (tokenData.state !== undefined && tokenData.state !== state) {
			throw new Error('VK token exchange failed: invalid state');
		}
		const data = await formJson('https://id.vk.ru/oauth2/user_info', {
			client_id: requireValue(this.config, 'VK_CLIENT_ID'),
			access_token: accessToken
		});
		if (!record(data.user))
			throw new Error('VK user info response is invalid');
		const user = data.user;
		const userId = requiredIdentifier(user, 'user_id');
		if (userId !== tokenUserId)
			throw new Error('VK user identity mismatch');
		return {
			providerId: userId,
			email: requiredEmail(requiredString(user, 'email')),
			name:
				[
					optionalString(user, 'first_name'),
					optionalString(user, 'last_name')
				]
					.filter(Boolean)
					.join(' ') || undefined,
			avatarPath: optionalString(user, 'avatar')
		};
	}

	private async exchange(
		endpoint: string,
		input: Record<string, string>
	): Promise<string> {
		const data = await formJson(endpoint, input);
		return requiredString(data, 'access_token');
	}

	private callbackUrl(provider: ProviderName): string {
		return requireValue(
			this.config,
			`${provider.toUpperCase()}_CALLBACK_URL`
		);
	}

	private cookie(provider: ProviderName): string {
		return `identityOAuthState_${provider}`;
	}

	private cookieScopeOptions(provider: ProviderName): CookieOptions {
		return {
			httpOnly: true,
			secure: process.env.MODE === 'production',
			sameSite: 'lax' as const,
			path: `/api/v1/auth/${provider}`
		};
	}

	private cookieOptions(provider: ProviderName): CookieOptions {
		return {
			...this.cookieScopeOptions(provider),
			maxAge: 10 * 60_000
		};
	}

	private clearCookieOptions(provider: ProviderName): CookieOptions {
		return this.cookieScopeOptions(provider);
	}

	private enum(provider: ProviderName): OAuthProvider {
		return OAuthProvider[
			provider.toUpperCase() as keyof typeof OAuthProvider
		];
	}

	private identityType(provider: ProviderName): AuthIdentityType {
		return AuthIdentityType[
			provider.toUpperCase() as keyof typeof AuthIdentityType
		];
	}
}

async function formJson(endpoint: string, input: Record<string, string>) {
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json'
		},
		body: new URLSearchParams(input),
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok)
		throw new Error(`OAuth provider failed HTTP ${response.status}`);
	const value = (await response.json()) as unknown;
	if (!record(value))
		throw new Error('OAuth provider returned invalid JSON');
	return value;
}

async function json(endpoint: string, token: string, scheme = 'Bearer') {
	const response = await fetch(endpoint, {
		headers: {
			authorization: `${scheme} ${token}`,
			accept: 'application/json'
		},
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok)
		throw new Error(`OAuth profile failed HTTP ${response.status}`);
	const value = (await response.json()) as unknown;
	if (!record(value))
		throw new Error('OAuth profile returned invalid JSON');
	return value;
}

async function jsonArray(
	endpoint: string,
	token: string
): Promise<unknown[]> {
	const response = await fetch(endpoint, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/json'
		},
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok)
		throw new Error(`OAuth profile failed HTTP ${response.status}`);
	const value = (await response.json()) as unknown;
	if (!Array.isArray(value))
		throw new Error('OAuth profile returned invalid JSON');
	return value;
}

function url(origin: string, values: Record<string, string>): string {
	return `${origin}?${new URLSearchParams(values)}`;
}

function requireValue(config: ConfigService, name: string): string {
	const value = config.get<string>(name)?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function record(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' && value !== null && !Array.isArray(value)
	);
}

function requiredString(
	value: Record<string, unknown>,
	key: string
): string {
	const candidate = value[key];
	if (typeof candidate !== 'string' || !candidate) {
		throw new Error(`OAuth provider response has no ${key}`);
	}
	return candidate;
}

function optionalString(
	value: Record<string, unknown>,
	key: string
): string | undefined {
	const candidate = value[key];
	return typeof candidate === 'string' && candidate
		? candidate
		: undefined;
}

function requiredIdentifier(
	value: Record<string, unknown>,
	key: string
): string {
	const candidate = value[key];
	if (typeof candidate === 'string' && candidate.trim()) return candidate;
	if (
		typeof candidate === 'number' &&
		Number.isSafeInteger(candidate) &&
		candidate > 0
	) {
		return String(candidate);
	}
	throw new Error(`OAuth provider response has no ${key}`);
}

function requiredEmail(value: unknown): string {
	if (typeof value !== 'string')
		throw new Error('OAuth provider response has no email');
	const email = normalizeEmail(value);
	if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new Error('OAuth provider response has invalid email');
	}
	return email;
}
