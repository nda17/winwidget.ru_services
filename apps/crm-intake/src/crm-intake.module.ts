import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmIntakeHealthController } from './health/crm-intake-health.controller';
import { CrmIntakeHealthService } from './health/crm-intake-health.service';
import { CrmIntakePrismaModule } from './prisma/crm-intake-prisma.module';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmIntakePrismaModule
	],
	controllers: [CrmIntakeHealthController],
	providers: [CrmIntakeHealthService]
})
export class CrmIntakeModule {}
