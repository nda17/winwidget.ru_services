import { NotesController } from '@/notes/notes.controller';
import { NotesService } from '@/notes/notes.service';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [NotesController],
	providers: [NotesService, PrismaService]
})
export class NotesModule {}
