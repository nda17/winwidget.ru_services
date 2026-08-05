import { Global, Module } from '@nestjs/common';
import { WidgetsPrismaService } from './widgets-prisma.service';

@Global()
@Module({
	providers: [WidgetsPrismaService],
	exports: [WidgetsPrismaService]
})
export class WidgetsPrismaModule {}
