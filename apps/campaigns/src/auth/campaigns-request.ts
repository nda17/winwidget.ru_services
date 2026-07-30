import type { IntrospectedActor } from '../internal/core-internal.client';
import type { Request } from 'express';

export interface CampaignsRequest extends Request {
	campaignsActor: IntrospectedActor;
}
