import { Global, Module } from '@nestjs/common';
import { SupportPrismaService } from './support-prisma.service';

@Global()
@Module({
	providers: [SupportPrismaService],
	exports: [SupportPrismaService]
})
export class SupportPrismaModule {}
