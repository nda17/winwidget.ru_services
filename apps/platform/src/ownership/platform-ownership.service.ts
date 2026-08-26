import {
	CanActivate,
	ExecutionContext,
	Injectable,
	ServiceUnavailableException,
	SetMetadata
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';

const PLATFORM_ALLOW_INACTIVE_OWNERSHIP =
	'platform-allow-inactive-ownership';

export const AllowInactivePlatformOwnership = () =>
	SetMetadata(PLATFORM_ALLOW_INACTIVE_OWNERSHIP, true);

@Injectable()
export class PlatformOwnershipService {
	constructor(private readonly prisma: PlatformPrismaService) {}

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
		if (!identity || identity.serviceName !== 'platform-service') {
			throw new ServiceUnavailableException(
				'Platform database marker is unavailable'
			);
		}
		return {
			serviceName: identity.serviceName,
			databaseId: identity.databaseId,
			phase: identity.phase,
			ownershipGeneration: identity.ownershipGeneration.toString(),
			importedAt: identity.importedAt?.toISOString() || null,
			activatedAt: identity.activatedAt?.toISOString() || null
		};
	}

	async isActive(): Promise<boolean> {
		try {
			const identity = await this.prisma.serviceIdentity.findUnique({
				where: { id: 'singleton' },
				select: {
					serviceName: true,
					phase: true,
					ownershipGeneration: true,
					sourceFingerprint: true,
					sourceHighWatermark: true,
					importedAt: true,
					activatedAt: true
				}
			});
			return Boolean(
				identity &&
				identity.serviceName === 'platform-service' &&
				identity.phase === 'ACTIVE' &&
				identity.ownershipGeneration >= 1n &&
				identity.sourceFingerprint &&
				/^[0-9a-f]{64}$/.test(identity.sourceFingerprint) &&
				identity.sourceHighWatermark !== null &&
				identity.sourceHighWatermark > 0n &&
				identity.importedAt &&
				identity.activatedAt &&
				identity.activatedAt >= identity.importedAt
			);
		} catch {
			return false;
		}
	}

	async assertActive(): Promise<void> {
		if (!(await this.isActive())) {
			throw new ServiceUnavailableException(
				'Platform ownership is not active'
			);
		}
	}
}

@Injectable()
export class PlatformOwnershipGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly ownership: PlatformOwnershipService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const allowInactiveOwnership =
			this.reflector.getAllAndOverride<boolean>(
				PLATFORM_ALLOW_INACTIVE_OWNERSHIP,
				[context.getHandler(), context.getClass()]
			);
		if (allowInactiveOwnership) return true;
		await this.ownership.assertActive();
		return true;
	}
}
