import type { Request } from 'express';

export type PlatformRole = 'USER' | 'ADMIN' | 'DEV';

export interface PlatformActor {
	active: true;
	subject: string;
	sessionId: string;
	roles: PlatformRole[];
}

export interface PlatformRequest extends Request {
	platformActor?: PlatformActor;
}
