import type { Request } from 'express';

export interface ReportingActor {
	active: true;
	subject: string;
	sessionId: string;
	roles: Array<'ADMIN' | 'DEV' | 'USER'>;
}

export interface ReportingRequest extends Request {
	reportingActor?: ReportingActor;
}
