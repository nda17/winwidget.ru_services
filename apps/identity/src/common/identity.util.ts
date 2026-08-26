import {
	createHash,
	randomBytes,
	randomInt,
	timingSafeEqual
} from 'node:crypto';
import type { Request } from 'express';

export const PASSWORD_SALT_ROUNDS = 12;
export const USER_DEACTIVATED_MESSAGE = 'User is deactivated';

export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

// Keep international values already accepted by the public Identity API.
export function normalizePhone(value: string): string {
	const digits = value.replace(/\D/g, '');
	if (
		digits.length === 11 &&
		(digits.startsWith('7') || digits.startsWith('8'))
	) {
		return `+7${digits.slice(1)}`;
	}
	if (digits.length === 10) {
		return `+7${digits}`;
	}
	if (digits.length > 0 && value.trim().startsWith('+')) {
		return `+${digits}`;
	}
	return value.trim();
}

export function base64Url(value: Buffer): string {
	return value.toString('base64url');
}

export function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex');
}

export function sha256Base64Url(value: string): string {
	return base64Url(createHash('sha256').update(value).digest());
}

export function randomToken(bytes = 32): string {
	return base64Url(randomBytes(bytes));
}

export function verificationCode(): string {
	return String(randomInt(100_000, 1_000_000));
}

export function safeEqual(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function clientIp(request: Request): string | undefined {
	const forwarded = request.headers['x-forwarded-for'];
	const candidate = Array.isArray(forwarded)
		? forwarded[0]
		: forwarded?.split(',')[0];
	return candidate?.trim() || request.ip || undefined;
}

export function safeError(error: unknown, max = 2_000): string {
	return (error instanceof Error ? error.message : 'Unknown error').slice(
		0,
		max
	);
}

export function parseUuid(value: string | undefined): string | null {
	return value &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value
		)
		? value
		: null;
}
