import {
	Roles,
	type PlatformRole
} from '@/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '@/auth/guards/jwt.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { applyDecorators, UseGuards } from '@nestjs/common';

export const Auth = (roles: PlatformRole | PlatformRole[] = ['USER']) => {
	if (!Array.isArray(roles)) {
		roles = [roles];
	}

	return applyDecorators(
		Roles(...roles),
		UseGuards(JwtAuthGuard, RolesGuard)
	);
};
