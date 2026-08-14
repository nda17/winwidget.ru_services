import {
	BadRequestException,
	CanActivate,
	ExecutionContext,
	Injectable,
	ServiceUnavailableException,
	SetMetadata
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthSettingsService } from './auth-settings.service';

const ACTION = 'recaptcha_action';
export const RecaptchaAction = (action: string) =>
	SetMetadata(ACTION, action);

@Injectable()
export class RecaptchaGuard implements CanActivate {
	private readonly enabled: boolean;
	private readonly secret: string;
	private readonly minimumScore: number;

	constructor(
		config: ConfigService,
		private readonly reflector: Reflector,
		private readonly settings: AuthSettingsService
	) {
		this.enabled = config.get<string>('RECAPTCHA_ENABLED') === 'true';
		this.secret = config.get<string>('RECAPTCHA_SECRET_KEY')?.trim() || '';
		this.minimumScore = Number(
			config.get<string>('RECAPTCHA_MIN_SCORE') || 0.5
		);
		if (
			this.enabled &&
			(!this.secret ||
				!Number.isFinite(this.minimumScore) ||
				this.minimumScore < 0 ||
				this.minimumScore > 1)
		) {
			throw new Error('reCAPTCHA configuration is invalid');
		}
	}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const action = this.reflector.getAllAndOverride<string>(ACTION, [
			context.getHandler(),
			context.getClass()
		]);
		if (!action) return true;
		const settings = await this.settings.get();
		if (!this.enabled || !settings.recaptchaEnabled) return true;
		const request = context.switchToHttp().getRequest<Request>();
		const candidate = request.header('recaptcha') || '';
		if (!candidate)
			throw new BadRequestException('Капча не была пройдена.');
		let response: Response;
		try {
			const body = new URLSearchParams({
				secret: this.secret,
				response: candidate
			});
			response = await fetch(
				'https://www.google.com/recaptcha/api/siteverify',
				{
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body,
					signal: AbortSignal.timeout(10_000)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Не удалось проверить reCAPTCHA. Попробуйте позже.'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Не удалось проверить reCAPTCHA. Попробуйте позже.'
			);
		}
		const result = (await response.json()) as {
			success?: boolean;
			action?: string;
			score?: number;
		};
		if (
			result.success !== true ||
			result.action !== action ||
			typeof result.score !== 'number' ||
			result.score < this.minimumScore
		) {
			throw new BadRequestException(
				'Проверка reCAPTCHA не пройдена. Попробуйте ещё раз.'
			);
		}
		return true;
	}
}
