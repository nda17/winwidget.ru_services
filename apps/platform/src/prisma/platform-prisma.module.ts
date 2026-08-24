import { Global, Module } from '@nestjs/common';
import { PlatformPrismaService } from './platform-prisma.service';

@Global()
@Module({
	providers: [PlatformPrismaService],
	exports: [PlatformPrismaService]
})
export class PlatformPrismaModule {}
