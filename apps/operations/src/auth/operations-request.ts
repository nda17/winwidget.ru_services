import type { Request } from 'express';

export type OperationsRole = 'USER' | 'ADMIN' | 'DEV';

export interface OperationsActor {
	active: true;
	subject: string;
	sessionId: string;
	roles: OperationsRole[];
}

export interface OperationsRequest extends Request {
	operationsActor?: OperationsActor;
}
