import { SetMetadata } from '@nestjs/common';
import type { IntrospectedActor } from '../internal/core-internal.client';

export const CAMPAIGNS_REQUIRED_ROLE = 'campaigns-required-role';
export type CampaignsRole = IntrospectedActor['roles'][number];

export const CampaignsRole = (role: CampaignsRole) =>
	SetMetadata(CAMPAIGNS_REQUIRED_ROLE, role);
