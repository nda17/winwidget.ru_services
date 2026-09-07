import {
	Body,
	Controller,
	ForbiddenException,
	Header,
	Headers,
	HttpCode,
	Post
} from '@nestjs/common';
import {
	assertCustomersPermission,
	CustomersAuthorizationClient,
	type CustomersAuthorization
} from '../access/customers-authorization.client';
import { assertCompanyLookupInn } from './company-lookup.contract';
import { CompanyLookupDto } from './company-lookup.dto';
import { CompanyLookupService } from './company-lookup.service';

function authority(context: CustomersAuthorization): string {
	return JSON.stringify({
		workspaceId: context.workspaceId,
		subject: context.subject,
		role: context.role,
		state: context.state,
		dataScope: context.dataScope,
		teamIds: [...context.teamIds].sort(),
		permissions: [...context.permissions].sort()
	});
}
function writable(context: CustomersAuthorization): void {
	assertCustomersPermission(context, 'customers:read');
	assertCustomersPermission(context, 'customers:write', true);
}

@Controller('crm/customers/company-lookup')
export class CompanyLookupController {
	constructor(
		private readonly authorization: CustomersAuthorizationClient,
		private readonly companies: CompanyLookupService
	) {}

	@Post()
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@Header('X-Content-Type-Options', 'nosniff')
	async lookup(
		@Headers('authorization') bearer: string | undefined,
		@Body() dto: CompanyLookupDto
	) {
		assertCompanyLookupInn(dto.inn);
		const context = await this.authorization.authorize(
			bearer,
			dto.workspaceId
		);
		if (context.workspaceId !== dto.workspaceId)
			throw new ForbiddenException(
				'Права доступа к пространству изменились.'
			);
		writable(context);
		const before = authority(context);
		const result = await this.companies.lookup(context, dto.inn);
		const fresh = await this.authorization.authorize(
			bearer,
			dto.workspaceId
		);
		writable(fresh);
		if (before !== authority(fresh))
			throw new ForbiddenException({
				code: 'crm_customers_permission_denied',
				message: 'Права доступа изменились. Повторите поиск.'
			});
		return result;
	}
}
