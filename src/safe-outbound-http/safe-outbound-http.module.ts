import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { Module } from '@nestjs/common';

@Module({
	providers: [SafeOutboundHttpService],
	exports: [SafeOutboundHttpService]
})
export class SafeOutboundHttpModule {}
