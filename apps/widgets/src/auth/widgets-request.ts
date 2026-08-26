import type { Request } from 'express';
import type { IntrospectedWidgetsActor } from '../internal/widgets-identity.client';

export interface WidgetsRequest extends Request {
	widgetsActor: IntrospectedWidgetsActor;
}
