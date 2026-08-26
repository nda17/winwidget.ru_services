import type { IntrospectedActor } from '../internal/campaigns-dependencies.client';
import type { Request } from 'express';

export interface CampaignsRequest extends Request {
	campaignsActor: IntrospectedActor;
}
