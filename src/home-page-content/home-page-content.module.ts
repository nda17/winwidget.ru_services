import { HomePageContentController } from '@/home-page-content/home-page-content.controller';
import { HomePageContentService } from '@/home-page-content/home-page-content.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [HomePageContentController],
	providers: [HomePageContentService]
})
export class HomePageContentModule {}
