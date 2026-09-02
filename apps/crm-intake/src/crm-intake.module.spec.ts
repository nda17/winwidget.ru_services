import { MODULE_METADATA } from '@nestjs/common/constants';
import { CrmIntakeModule } from './crm-intake.module';
import { CrmIntakePrismaModule } from './prisma/crm-intake-prisma.module';
import { CrmIntakePrismaService } from './prisma/crm-intake-prisma.service';

describe('CrmIntakeModule', () => {
	it('imports the global Prisma module exactly once at the root', () => {
		const imports = Reflect.getMetadata(
			MODULE_METADATA.IMPORTS,
			CrmIntakeModule
		) as unknown[];
		expect(
			imports.filter(item => item === CrmIntakePrismaModule)
		).toHaveLength(1);
	});

	it('keeps PrismaService owned only by the global Prisma module', () => {
		const rootProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmIntakeModule
		) as unknown[];
		const prismaProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmIntakePrismaModule
		) as unknown[];
		expect(rootProviders).not.toContain(CrmIntakePrismaService);
		expect(prismaProviders).toEqual([CrmIntakePrismaService]);
	});
});
