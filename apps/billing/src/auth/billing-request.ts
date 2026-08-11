import type { Request } from 'express';

export type BillingRole = 'USER' | 'ADMIN' | 'DEV';

export interface BillingActor {
	active: true;
	subject: string;
	sessionId: string;
	roles: BillingRole[];
}

export interface BillingRequest extends Request {
	billingActor?: BillingActor;
}
