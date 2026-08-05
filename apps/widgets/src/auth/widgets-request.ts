import type { Request } from 'express';
import type { IntrospectedWidgetsActor } from '../internal/core-internal.client';

export interface WidgetsRequest extends Request {
	widgetsActor: IntrospectedWidgetsActor;
}
