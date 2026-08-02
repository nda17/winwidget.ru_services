import { ReportingPrismaService } from './reporting-prisma.service';
import { Global, Module } from '@nestjs/common';

@Global()
@Module({
	providers: [ReportingPrismaService],
	exports: [ReportingPrismaService]
})
export class ReportingPrismaModule {}
