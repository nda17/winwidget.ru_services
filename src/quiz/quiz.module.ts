import { AuthModule } from '@/auth/auth.module';
import { FileModule } from '@/file/file.module';
import { SafeOutboundHttpModule } from '@/safe-outbound-http/safe-outbound-http.module';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { QuizApiController } from '@/quiz/quiz-api.controller';
import { QuizPublicController } from '@/quiz/quiz-public.controller';
import { QuizController } from '@/quiz/quiz.controller';
import { QuizService } from '@/quiz/quiz.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AuthModule,
		SubscriptionModule,
		FileModule,
		SafeOutboundHttpModule
	],
	controllers: [QuizController, QuizPublicController, QuizApiController],
	providers: [QuizService],
	exports: [QuizService]
})
export class QuizModule {}
