import {
	Controller,
	Get,
	NotFoundException,
	Param,
	Res
} from '@nestjs/common';
import { Response } from 'express';

@Controller()
export class CalculatorPublicController {
	@Get('page-calculator/:key')
	serveCalculatorPage(@Param('key') key: string, @Res() res: Response) {
		if (!/^[a-f0-9]{12}$/.test(key)) {
			throw new NotFoundException('Калькулятор не найден');
		}

		res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
		res.setHeader('X-Frame-Options', 'SAMEORIGIN');
		res.setHeader('Content-Type', 'text/html; charset=utf-8');

		return res.send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Калькулятор стоимости — WinWidget</title>
  <style>
    html,body{margin:0;min-height:100%;background:#0d0d1a;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  </style>
</head>
<body>
  <script>window.wincalculatorAutoOpen = true;</script>
  <script src="/widgets/calculator.js" data-key="${key}" async></script>
</body>
</html>`);
	}
}
