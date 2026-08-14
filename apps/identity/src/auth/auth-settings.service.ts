import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/identity-client';
import type { Request } from 'express';
import { clientIp } from '../common/identity.util';
import { IdentityEventsService } from '../events/identity-events.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { UpdateAuthSettingsDto } from './auth.dto';

export const AUTH_SETTING_KEYS = [
	'recaptchaEnabled',
	'googleAuthEnabled',
	'yandexAuthEnabled',
	'githubAuthEnabled',
	'vkAuthEnabled',
	'telegramAuthEnabled'
] as const;

const PROVIDER_DISABLED_MESSAGES = {
	google: 'Google auth is disabled',
	github: 'Github auth is disabled',
	yandex: 'Yandex auth is disabled',
	vk: 'VK auth is disabled',
	telegram: 'Telegram auth is disabled'
} as const;

@Injectable()
export class AuthSettingsService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly events: IdentityEventsService
	) {}

	async get() {
		const settings = await this.prisma.authSettings.findUniqueOrThrow({
			where: { id: 'singleton' }
		});
		return this.select(settings);
	}

	async update(
		actorId: string,
		dto: UpdateAuthSettingsDto,
		request: Request
	) {
		return this.prisma.$transaction(async transaction => {
			const settings = await transaction.authSettings.update({
				where: { id: 'singleton' },
				data: dto
			});
			await this.events.emitAudit(transaction, {
				actorId,
				section: 'SITE_SETTINGS',
				action: 'SITE_SETTINGS_UPDATE',
				entityType: 'auth_settings',
				entityId: 'singleton',
				description: 'Обновлены настройки авторизации',
				metadata: {
					changedFields: Object.keys(dto),
					...Object.fromEntries(
						AUTH_SETTING_KEYS.map(key => [key, settings[key]])
					)
				} as Prisma.InputJsonObject,
				requestId: request.header('x-request-id'),
				requestIp: clientIp(request),
				requestUserAgent: request.get('user-agent')?.slice(0, 500),
				correlationId: request.header('x-correlation-id')
			});
			return this.select(settings);
		});
	}

	async assertProviderEnabled(
		provider: 'google' | 'github' | 'yandex' | 'vk' | 'telegram'
	) {
		const settings = await this.get();
		const key = `${provider}AuthEnabled` as keyof typeof settings;
		if (!settings[key]) {
			const { ForbiddenException } = await import('@nestjs/common');
			throw new ForbiddenException(PROVIDER_DISABLED_MESSAGES[provider]);
		}
	}

	private select(
		settings: Record<(typeof AUTH_SETTING_KEYS)[number], boolean>
	) {
		return Object.fromEntries(
			AUTH_SETTING_KEYS.map(key => [key, settings[key]])
		) as Record<(typeof AUTH_SETTING_KEYS)[number], boolean>;
	}
}
