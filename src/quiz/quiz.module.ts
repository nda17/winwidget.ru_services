import { AuthModule } from '@/auth/auth.module';
import { EmailModule } from '@/email/email.module';
import { FileModule } from '@/file/file.module';
import { PrismaService } from '@/prisma.service';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { QuizApiController } from '@/quiz/quiz-api.controller';
import { QuizPublicController } from '@/quiz/quiz-public.controller';
import { QuizController } from '@/quiz/quiz.controller';
import { QuizService } from '@/quiz/quiz.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule, SubscriptionModule, EmailModule, FileModule],
	controllers: [QuizController, QuizPublicController, QuizApiController],
	providers: [QuizService, PrismaService],
	exports: [QuizService]
})
export class QuizModule {}
