import { SetMetadata } from '@nestjs/common';
import type { IntrospectedWidgetsActor } from '../internal/core-internal.client';

export const WIDGETS_REQUIRED_ROLES = 'widgets-required-roles';
export type WidgetsRole = IntrospectedWidgetsActor['roles'][number];

export const WidgetsRoles = (...roles: WidgetsRole[]) =>
	SetMetadata(WIDGETS_REQUIRED_ROLES, roles);
