import { StatisticsController } from '@/statistics/statistics.controller';
import { StatisticsService } from '@/statistics/statistics.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [StatisticsController],
	providers: [StatisticsService],
	exports: [StatisticsService]
})
export class StatisticsModule {}
