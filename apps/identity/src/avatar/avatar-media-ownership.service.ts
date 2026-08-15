import {
	CanActivate,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { AvatarMediaOwnershipPhase } from '@prisma/identity-client';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';

@Injectable()
export class AvatarMediaOwnershipService {
	constructor(private readonly prisma: IdentityPrismaService) {}

	async assertActive(): Promise<void> {
		let ownership: { phase: AvatarMediaOwnershipPhase } | null;
		try {
			ownership = await this.prisma.avatarMediaOwnership.findUnique({
				where: { id: 'singleton' },
				select: { phase: true }
			});
		} catch {
			throw new ServiceUnavailableException(
				'Avatar media ownership is unavailable'
			);
		}
		if (ownership?.phase !== AvatarMediaOwnershipPhase.ACTIVE) {
			throw new ServiceUnavailableException(
				'Avatar media ownership is not active'
			);
		}
	}
}

@Injectable()
export class AvatarMediaOwnershipGuard implements CanActivate {
	constructor(private readonly ownership: AvatarMediaOwnershipService) {}

	async canActivate(): Promise<true> {
		await this.ownership.assertActive();
		return true;
	}
}
