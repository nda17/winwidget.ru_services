import { MODULE_METADATA } from '@nestjs/common/constants';
import { CrmCustomersModule } from './crm-customers.module';
import { CrmCustomersPrismaModule } from './prisma/crm-customers-prisma.module';
import { CrmCustomersPrismaService } from './prisma/crm-customers-prisma.service';
import { CompaniesV2Controller } from './customers/companies-v2.controller';
import { CompanyLookupController } from './company-lookup/company-lookup.controller';
import { CompanyLookupService } from './company-lookup/company-lookup.service';
import { CompanyLookupProvider } from './company-lookup/company-lookup.provider';
import { DadataCompanyLookupAdapter } from './company-lookup/dadata-company-lookup.adapter';

describe('CrmCustomersModule', () => {
	it('registers v2 companies and lookup in the existing Customers context', () => {
		const controllers = Reflect.getMetadata(
			MODULE_METADATA.CONTROLLERS,
			CrmCustomersModule
		) as unknown[];
		const providers = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmCustomersModule
		) as unknown[];
		expect(controllers).toContain(CompaniesV2Controller);
		expect(controllers).toContain(CompanyLookupController);
		expect(
			providers.filter(provider => provider === CompanyLookupService)
		).toHaveLength(1);
		expect(providers).toContainEqual({
			provide: CompanyLookupProvider,
			useClass: DadataCompanyLookupAdapter
		});
	});
	it('imports the global Prisma module exactly once at the root', () => {
		const imports = Reflect.getMetadata(
			MODULE_METADATA.IMPORTS,
			CrmCustomersModule
		) as unknown[];
		expect(
			imports.filter(item => item === CrmCustomersPrismaModule)
		).toHaveLength(1);
	});

	it('keeps PrismaService owned only by the global Prisma module', () => {
		const rootProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmCustomersModule
		) as unknown[];
		const prismaProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmCustomersPrismaModule
		) as unknown[];
		expect(rootProviders).not.toContain(CrmCustomersPrismaService);
		expect(prismaProviders).toEqual([CrmCustomersPrismaService]);
	});
});
