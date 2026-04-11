import { IFileResponse } from '@/file/file.interface'
import { Injectable } from '@nestjs/common'
import { path } from 'app-root-path'
import { ensureDir, writeFile } from 'fs-extra'
import { extname } from 'path'

@Injectable()
export class FileService {
	async saveFiles(
		files: Express.Multer.File[],
		folder: string = 'default'
	): Promise<IFileResponse[]> {
		const uploadFolder = `${path}/uploads/${folder}`
		await ensureDir(uploadFolder)

		const res: IFileResponse[] = await Promise.all(
			files.map(async (file) => {
				const decodedOriginalName = Buffer.from(
					file.originalname,
					'latin1'
				).toString('utf8')
				const fileExtension =
					extname(decodedOriginalName) || extname(file.originalname)
				const safeFileName = `${Date.now()}-${Math.random()
					.toString(36)
					.slice(2, 10)}${fileExtension.toLowerCase()}`

				await writeFile(
					`${uploadFolder}/${safeFileName}`,
					file.buffer
				)

				return {
					url: `/uploads/${folder}/${safeFileName}`,
					name: decodedOriginalName
				}
			})
		)

		return res
	}
}
