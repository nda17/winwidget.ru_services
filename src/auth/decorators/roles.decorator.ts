import type { IdentityActor } from '@/identity-boundary/identity-internal.client';
import { SetMetadata } from '@nestjs/common';

export type PlatformRole = IdentityActor['roles'][number];

export interface PlatformIdentityActor {
	id: IdentityActor['subject'];
	rights: PlatformRole[];
	sessionId: IdentityActor['sessionId'];
}

export const Roles = (...roles: PlatformRole[]) =>
	SetMetadata('roles', roles);
