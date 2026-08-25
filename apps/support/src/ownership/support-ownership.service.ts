import {
	CanActivate,
	ExecutionContext,
	Injectable,
	ServiceUnavailableException,
	SetMetadata
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupportPrismaService } from '../prisma/support-prisma.service';

const SUPPORT_ALLOW_SHADOW = 'support-allow-shadow';

export const AllowSupportShadow = () =>
	SetMetadata(SUPPORT_ALLOW_SHADOW, true);

@Injectable()
export class SupportOwnershipService {
	constructor(private readonly prisma: SupportPrismaService) {}

	async state() {
		const identity = await this.prisma.serviceIdentity.findUnique({
			where: { id: 'singleton' },
			select: {
				serviceName: true,
				databaseId: true,
				phase: true,
				ownershipGeneration: true,
				importedAt: true,
				activatedAt: true
			}
		});
		if (!identity || identity.serviceName !== 'support-service') {
			throw new ServiceUnavailableException(
				'Support database marker is unavailable'
			);
		}
		return {
			...identity,
			ownershipGeneration: identity.ownershipGeneration.toString(),
			importedAt: identity.importedAt?.toISOString() || null,
			activatedAt: identity.activatedAt?.toISOString() || null
		};
	}

	async isActive(): Promise<boolean> {
		try {
			const [identity, settings] = await Promise.all([
				this.prisma.serviceIdentity.findUnique({
					where: { id: 'singleton' }
				}),
				this.prisma.routingSettings.findUnique({
					where: { id: 'singleton' }
				})
			]);
			return Boolean(
				identity?.serviceName === 'support-service' &&
				identity.phase === 'ACTIVE' &&
				identity.ownershipGeneration >= 1n &&
				identity.sourceFingerprint &&
				/^[0-9a-f]{64}$/.test(identity.sourceFingerprint) &&
				identity.sourceHighWatermark !== null &&
				identity.sourceHighWatermark > 0n &&
				identity.importedAt &&
				identity.activatedAt &&
				identity.activatedAt >= identity.importedAt &&
				settings?.adminChatId.trim() &&
				settings.supportThreadId &&
				settings.supportThreadId > 0
			);
		} catch {
			return false;
		}
	}

	async assertActive(): Promise<void> {
		if (!(await this.isActive())) {
			throw new ServiceUnavailableException(
				'Support ownership is not active'
			);
		}
	}
}

@Injectable()
export class SupportOwnershipGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly ownership: SupportOwnershipService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const allowShadow = this.reflector.getAllAndOverride<boolean>(
			SUPPORT_ALLOW_SHADOW,
			[context.getHandler(), context.getClass()]
		);
		if (allowShadow) return true;
		await this.ownership.assertActive();
		return true;
	}
}
