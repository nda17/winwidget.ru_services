import {
	CanActivate,
	ExecutionContext,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ServiceDatabasePhase } from '@prisma/identity-client';
import type { Request } from 'express';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';

@Injectable()
export class IdentityOwnershipService {
	constructor(private readonly prisma: IdentityPrismaService) {}

	async state() {
		const value = await this.prisma.serviceIdentity.findUnique({
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
		if (!value || value.serviceName !== 'identity-service') {
			throw new ServiceUnavailableException(
				'Identity database ownership is not ready'
			);
		}
		return value;
	}

	async isActive(): Promise<boolean> {
		try {
			return (await this.state()).phase === ServiceDatabasePhase.ACTIVE;
		} catch {
			return false;
		}
	}

	async assertActive(): Promise<void> {
		if (!(await this.isActive())) {
			throw new ServiceUnavailableException(
				'Identity ownership is not active'
			);
		}
	}
}

@Injectable()
export class IdentityOwnershipGuard implements CanActivate {
	constructor(private readonly ownership: IdentityOwnershipService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<Request>();
		if (request.path.startsWith('/health/')) return true;
		await this.ownership.assertActive();
		return true;
	}
}
