import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { NotesController } from '@/notes/notes.controller';
import { NotesService } from '@/notes/notes.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AdminEventLogModule],
	controllers: [NotesController],
	providers: [NotesService]
})
export class NotesModule {}
