import {
	BadRequestException,
	ConflictException,
	ForbiddenException
} from '@nestjs/common';
import { Prisma } from '@prisma/support-client';
import { createHash } from 'node:crypto';
import type { SupportActor } from '../auth/support-request';
import type { SupportPrismaService } from '../prisma/support-prisma.service';
import { canonicalSupportJson } from '../telegram/support-telegram-outbound.service';

export const hashSupport = (value: unknown) =>
	createHash('sha256').update(canonicalSupportJson(value)).digest('hex');
export function assertSupportActor(
	actor: SupportActor,
	expected: string
): void {
	if (actor.subject !== expected)
		throw new ForbiddenException({
			code: 'support_actor_changed',
			message:
				'Учётная запись изменилась. Проверьте обращение перед отправкой.'
		});
}
export function supportConflict(
	message = 'Команда уже использована с другим содержимым'
): never {
	throw new ConflictException({ code: 'support_conflict', message });
}
export function exactObject(
	value: unknown,
	keys: string[]
): value is Record<string, unknown> {
	return Boolean(
		value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every(key => Object.hasOwn(value, key))
	);
}
export async function supportTransaction<T>(
	prisma: SupportPrismaService,
	fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await prisma.$transaction(fn, {
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			});
		} catch (error) {
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				(['P2034', 'P2002'].includes(error.code) ||
					(error.code === 'P2010' &&
						['40001', '40P01'].includes(String(error.meta?.code)))) &&
				attempt < 3
			)
				continue;
			throw error;
		}
	}
}
export function assertWebText(value: string): string {
	if (!value.trim() || /\x00/.test(value))
		throw new BadRequestException('Сообщение не может быть пустым');
	return value.trim();
}
