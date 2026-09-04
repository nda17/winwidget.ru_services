import {
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { serviceOrigin } from './sales-access';

@Injectable()
export class SalesContactClient {
	async requireContact(
		authorization: string,
		workspaceId: string,
		contactId: string
	): Promise<{ id: string; name: string }> {
		const origin = serviceOrigin(
			process.env.CRM_CUSTOMERS_INTERNAL_BASE_URL
		);
		let response: Response;
		try {
			response = await fetch(
				`${origin}/api/v1/crm/customers/contacts/${encodeURIComponent(contactId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
				{
					headers: { Authorization: authorization },
					cache: 'no-store',
					redirect: 'error',
					signal: AbortSignal.timeout(5000)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'CRM contacts are temporarily unavailable'
			);
		}
		if (response.status === 401) throw new UnauthorizedException();
		if (response.status === 403) throw new ForbiddenException();
		if (response.status === 404)
			throw new NotFoundException({
				code: 'crm_sales_contact_not_found',
				message: 'Контакт недоступен'
			});
		try {
			if (!response.ok) throw new Error();
			const data: unknown = await response.json();
			if (!data || typeof data !== 'object' || Array.isArray(data))
				throw new Error();
			const root = data as Record<string, unknown>;
			if (
				root.schemaVersion !== 1 ||
				Object.keys(root).sort().join(',') !== 'contact,schemaVersion' ||
				!root.contact ||
				typeof root.contact !== 'object' ||
				Array.isArray(root.contact)
			)
				throw new Error();
			const contact = root.contact as Record<string, unknown>;
			const keys = [
				'id',
				'workspaceId',
				'name',
				'notes',
				'createdBySubject',
				'teamId',
				'version',
				'archivedAt',
				'createdAt',
				'updatedAt',
				'phone',
				'email',
				'companyId'
			];
			if (
				Object.keys(contact).length !== keys.length ||
				keys.some(key => !(key in contact)) ||
				contact.id !== contactId ||
				contact.workspaceId !== workspaceId ||
				contact.archivedAt !== null ||
				typeof contact.name !== 'string' ||
				!contact.name.trim() ||
				contact.name.length > 200
			)
				throw new Error();
			return { id: contactId, name: contact.name };
		} catch {
			throw new ServiceUnavailableException(
				'CRM contact response is unavailable'
			);
		}
	}
}
