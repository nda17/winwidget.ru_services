import type { Request } from 'express';

export type SupportRole = 'USER' | 'ADMIN' | 'DEV';

export interface SupportActor {
	active: true;
	subject: string;
	sessionId: string;
	roles: SupportRole[];
}

export type SupportRequest = Request & { supportActor?: SupportActor };
