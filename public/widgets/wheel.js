//сделать настройку ограничения попыток по ip по дням в блоке ограничения в лк пользователя, нужно при прокрутке получать ip клиента и добавить ограничение оп номеру тел

(function () {
	// Защита от двойного выполнения (React StrictMode и т.п.)
	if (window.__winwidgetScriptRunning) {
		return;
	}
	window.__winwidgetScriptRunning = true;

	// Захватываем currentScript синхронно — после async он будет null
	var _currentScript = document.currentScript;

	var API_BASE = (() => {
		try {
			const src = new URL(_currentScript?.src || location.href);
			if (src.hostname === 'localhost') return `${src.origin}/api`;
			return `${src.origin}/api`;
		} catch {
			return 'https://winwidget.ru/api';
		}
	})();

	const isMobile = window.matchMedia('(max-width: 767px)').matches;
	const giftBtn = document.createElement('div');
	const giftFontSize = isMobile ? '52px' : '64px';
	giftBtn.innerHTML = `
  <div style="
    font-size:${giftFontSize};line-height:1;
    filter:drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2));
    transform-origin:50% 100%;
  ">🎁</div>
  <div style="
    margin-top:6px;
    background:linear-gradient(135deg,#ffd700,#ff8c00);
    color:#1a0600;font-size:11px;font-weight:900;
    padding:3px 12px;border-radius:20px;white-space:nowrap;
    letter-spacing:0.8px;text-transform:uppercase;
    box-shadow:0 3px 10px rgba(255,140,0,0.5);
  ">Приз!</div>
`;
	giftBtn.style.cssText = `
    position: fixed;
    bottom: 28px;
    right: max(28px, env(safe-area-inset-right, 0px) + 28px);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    cursor: pointer;
    z-index: 9999;
    max-width: calc(100vw - 56px);
    transition: opacity 350ms ease, transform 350ms cubic-bezier(.34,1.56,.64,1);
    user-select: none;
`;
	giftBtn.style.display = 'none'; // скрыта до загрузки конфига
	document.body.appendChild(giftBtn);

	/************************ Анимацаия плавающей кнопки открытия виджета ************************/
	const styleAnimGiftBtn = document.createElement('style');
	styleAnimGiftBtn.textContent = `
@keyframes gift-bounce {
  0%   { transform: translateY(0) scale(1); }
  10%  { transform: translateY(-16px) scale(1.1); }
  20%  { transform: translateY(0) scale(1); }
  30%  { transform: translateY(-6px) scale(1.04); }
  40%  { transform: translateY(0) scale(1); }
  100% { transform: translateY(0) scale(1); }
}
@keyframes gift-sway {
  0%   { transform: rotate(0deg); }
  25%  { transform: rotate(-6deg); }
  75%  { transform: rotate(6deg); }
  100% { transform: rotate(0deg); }
}
@keyframes gift-pulse {
  0%   { filter: drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2)); }
  50%  { filter: drop-shadow(0 8px 28px rgba(101,16,255,0.7)) drop-shadow(0 2px 12px rgba(37,117,252,0.5)); }
  100% { filter: drop-shadow(0 6px 16px rgba(0,0,0,0.35)) drop-shadow(0 2px 4px rgba(0,0,0,0.2)); }
}
`;

	document.head.appendChild(styleAnimGiftBtn);

	let giftAnimationActive = false;
	let giftIdleTimeout = null;
	let _giftPulseEnabled = true; // обновляется из initWidget

	function startGiftAnimation() {
		if (giftAnimationActive) return;
		giftAnimationActive = true;

		giftBtn.style.animation = [
			'gift-bounce 3s ease-in-out infinite',
			'gift-sway 4s ease-in-out infinite',
			_giftPulseEnabled ? 'gift-pulse 2.5s ease-in-out infinite' : ''
		]
			.filter(Boolean)
			.join(', ');
	}

	function stopGiftAnimation() {
		giftAnimationActive = false;
		giftBtn.style.animation = 'none';
	}

	setTimeout(() => {
		startGiftAnimation();
	}, 4000);

	let scrollTriggered = false;

	window.addEventListener(
		'scroll',
		() => {
			if (scrollTriggered) return;
			scrollTriggered = true;

			giftBtn.animate(
				[
					{ transform: 'translateY(0) rotate(0deg)' },
					{ transform: 'translateY(-250px) rotate(-6deg)' },
					{ transform: 'translateY(0) rotate(0deg)' }
				],
				{
					duration: 2300,
					easing: 'cubic-bezier(.34,1.56,.64,1)'
				}
			);

			startGiftAnimation();
		},
		{ passive: true }
	);
	/************************/

	async function initWidget(config) {
		function firePixelEvent(goalName) {
			if (config.yandexMetrikaId && typeof ym === 'function') {
				try {
					ym(Number(config.yandexMetrikaId), 'reachGoal', goalName);
				} catch (e) {}
			}
			if (config.vkPixelId && window.VK && typeof VK.Goal === 'function') {
				try {
					VK.Goal(goalName);
				} catch (e) {}
			}
			if (
				config.roistatEnabled &&
				window.roistat &&
				typeof window.roistat.event === 'object' &&
				typeof window.roistat.event.send === 'function'
			) {
				try {
					window.roistat.event.send(goalName);
				} catch (e) {}
			}
		}

		function openWidget() {
			mainWrapper.classList.remove('hidden');
			mainWrapper.classList.add('visible');
			// Блокируем скролл страницы
			document.body.style.overflow = 'hidden';
			document.body.style.position = 'fixed';
			document.body.style.width = '100%';
			giftBtn.style.opacity = '0';
			giftBtn.style.pointerEvents = 'none';
			giftBtn.style.transform = 'scale(0.8)';
			stopGiftAnimation();
			firePixelEvent('ip3_open');
		}

		function closeWidget() {
			mainWrapper.classList.remove('visible');
			mainWrapper.classList.add('hidden');
			// Разблокируем скролл страницы
			document.body.style.overflow = '';
			document.body.style.position = '';
			document.body.style.width = '';
			if (!window.winwidgetAutoOpen) {
				giftBtn.style.opacity = '1';
				giftBtn.style.pointerEvents = 'auto';
				giftBtn.style.transform = 'scale(1)';
				startGiftAnimation();
			}
		}

		//Создаем HTML контейнер для ShadowDOM
		const host = document.createElement('div');
		host.id = 'wheel-widget-host';
		document.body.appendChild(host);

		// //Инициализируем Shadow DOM
		const shadow = host.attachShadow({ mode: 'open' });

		//CSS
		const style = document.createElement('style');

		style.textContent = `
    :host {
      --spin-duration: ${config.spinDuration || 5}s;
      --wheel-size: 300px;
      --accent: ${config.widgetColor};
      position: fixed;
      z-index: 100;
      top: 0;
    }
    * { box-sizing: border-box; }

    /* ── Обёртка на весь экран ── */
    #main-wrapper {
      width: 100vw;
      height: 100dvh;
      display: none;
      overflow-x: hidden;
      overflow-y: auto;
      justify-content: center;
      align-items: flex-start;
      padding: 12px;
    }

    /* ── Полупрозрачный фон ── */
    #overlay {
      position: fixed;
      inset: 0;
      background: rgba(8, 4, 20, 0.85);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 999;
      touch-action: none;
    }

    /* ── Карточка ── */
    #banner-wrapper {
      position: relative;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 28px 20px 24px;
      background: ${config.bgColor};
      border-radius: 20px;
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.08),
        0 24px 64px rgba(0,0,0,0.55),
        0 0 80px rgba(101,16,255,0.18);
      overflow: hidden;
      clip-path: inset(0 round 20px);
      gap: 28px;
      touch-action: pan-y;
      min-height: calc(100dvh - 24px);
      justify-content: center;
    }

    /* Декоративный блик сверху */
    #banner-wrapper::before {
      content: '';
      position: absolute;
      top: 0; left: 10%; right: 10%;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
      pointer-events: none;
    }

    /* ── Контент (форма + колесо) ── */
    #banner-content {
      display: flex;
      flex-direction: column;
      width: 100%;
      justify-content: center;
      align-items: center;
      gap: 24px;
    }

    /* ── Колесо ── */
    #wheel-wrapper {
      position: relative;
      width: var(--wheel-size);
      height: var(--wheel-size);
      filter: drop-shadow(0 8px 32px rgba(0,0,0,0.45));
    }
    svg { width: 100%; height: 100%; overflow: visible; }
    #wheel {
      transform-origin: 50% 50%;
      transition: transform var(--spin-duration) cubic-bezier(.17,.67,.3,1);
    }
    .sector text { pointer-events: none; user-select: none; }

    /* Стрелка */
    #wheel-arrow {
      position: absolute;
      top: 50%;
      right: -18px;
      transform: translateY(-50%);
      width: 44px;
      height: 44px;
      z-index: 10;
      pointer-events: none;
      filter: drop-shadow(0 2px 6px rgba(0,0,0,0.5));
    }
    #wheel-arrow svg { width: 100%; height: 100%; display: block; }

    /* ── Панель управления ── */
    #control-wrapper {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      width: 100%;
    }

    /* Заголовок */
    #title-widget {
      font-size: clamp(1.1rem, 4.5vw, 1.75rem);
      font-weight: 800;
      margin: 0;
      text-align: center;
      color: #ffffff;
      letter-spacing: -0.3px;
      line-height: 1.2;
      text-shadow: 0 2px 12px rgba(0,0,0,0.3);
      overflow-wrap: break-word;
      word-break: break-word;
    }

    /* Подзаголовок */
    #subtitle-widget {
      width: 100%;
      color: rgba(255,255,255,0.72);
      margin: 0;
      text-align: center;
      font-size: 14px;
      line-height: 1.5;
    }

    /* Инпуты */
    #name-input,
    #phone-input,
    #email-input {
      border: 1.5px solid rgba(255,255,255,0.12);
      outline: none;
      background: rgba(255,255,255,0.08);
      padding: 0 14px;
      border-radius: 12px;
      width: 100%;
      color: #ffffff;
      font-weight: 400;
      font-size: 15px;
      line-height: 1;
      height: 48px;
      transition: border-color 250ms, background 250ms, box-shadow 250ms;
      backdrop-filter: blur(4px);
    }
    #name-input::placeholder,
    #phone-input::placeholder,
    #email-input::placeholder { color: rgba(255,255,255,0.4); }
    #name-input:focus,
    #phone-input:focus,
    #email-input:focus {
      border-color: rgba(255,255,255,0.4);
      background: rgba(255,255,255,0.13);
      box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
    }

    /* Кнопка КРУТИТЬ */
    #spin {
      width: 100%;
      padding: 0 24px;
      height: 52px;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.5px;
      cursor: pointer;
      border: none;
      border-radius: 14px;
      color: #ffffff;
      background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
      box-shadow: 0 4px 20px rgba(101,16,255,0.45), inset 0 1px 0 rgba(255,255,255,0.15);
      transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
      position: relative;
      overflow: hidden;
    }
    #spin::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(255,255,255,0.1) 0%, transparent 60%);
      pointer-events: none;
    }
    #spin:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 28px rgba(101,16,255,0.6), inset 0 1px 0 rgba(255,255,255,0.15);
      filter: brightness(1.08);
    }
    #spin:active { transform: translateY(0); }
    #spin:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
    }

    /* Ссылки политики */
    #link-policy, #link-consent, #link-offer {
      color: rgba(255,255,255,0.75);
      text-decoration: underline;
      text-underline-offset: 2px;
      cursor: pointer;
      transition: color 0.2s;
    }
    #link-policy:hover, #link-consent:hover, #link-offer:hover {
      color: #ffffff;
    }

    /* Брендинг */
    #dev-info {
      font-size: 12px;
      position: absolute;
      top: 5px;
      color: rgba(255,255,255,0.35);
      letter-spacing: 0.2px;
    }
    #dev-info-text {
      color: rgba(255,200,50,0.7);
      text-decoration: none;
      font-weight: 600;
    }
    #dev-info-text:hover { color: #ffc832; }

    /* Конфетти */
    .confetti {
      position: absolute;
      width: 8px;
      height: 8px;
      pointer-events: none;
      opacity: 1;
      transform-origin: center center;
      will-change: transform, opacity;
    }
    .confetti.square { border-radius: 2px; }
    .confetti.circle { border-radius: 50%; }
    .confetti.diamond { border-radius: 1px; transform: rotate(45deg); }
    .confetti.streamer { width: 4px !important; height: 20px !important; border-radius: 2px; }

    .blur { filter: blur(2.5px); }
    .visible { display: flex !important; }
    .hidden { display: none !important; }

    /* Кнопка закрытия */
    #widget-close {
      position: absolute;
      top: 14px;
      right: 14px;
      width: 34px;
      height: 34px;
      padding: 0;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s, transform 0.2s, border-color 0.2s;
      backdrop-filter: blur(4px);
    }
    #widget-close:hover {
      background: rgba(255,255,255,0.2);
      border-color: rgba(255,255,255,0.25);
      transform: scale(1.08) rotate(90deg);
    }
    #widget-close svg { width: 14px; height: 14px; }
    #widget-close line {
      stroke: rgba(255,255,255,0.85);
      stroke-width: 2;
      stroke-linecap: round;
    }

    /* ── Desktop ── */
    @media (min-width: 768px) {
      :host { --wheel-size: 360px; }
      #main-wrapper { align-items: center; }
      #banner-content {
        flex-direction: row-reverse;
        gap: 48px;
      }
      #banner-wrapper {
        width: 100%;
        padding: 44px 48px;
        max-width: 940px;
        max-height: 520px;
        min-height: unset;
        justify-content: flex-start;
      }
      #control-wrapper { max-width: 290px; gap: 12px; }
      #title-widget { font-size: clamp(1.5rem, 2vw, 2rem); }
      #dev-info { right: 14px; }
    }

    @supports not (height: 100dvh) {
      #main-wrapper { height: 100vh; }
    }

    /* ── Checkbox ── */
    #checkbox-text {
      color: rgba(255,255,255,0.65);
      font-size: 13px;
      line-height: 1.45;
    }
    #custom-checkbox {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      line-height: 1.45;
    }
    #custom-checkbox input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    #custom-checkbox #checkmark {
      width: 18px;
      height: 18px;
      min-width: 18px;
      margin-top: 1px;
      border-radius: 5px;
      border: 1.5px solid rgba(255,255,255,0.35);
      background: rgba(255,255,255,0.06);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }
    #custom-checkbox #checkmark::after {
      content: '';
      width: 10px;
      height: 6px;
      border-left: 2px solid #fff;
      border-bottom: 2px solid #fff;
      transform: rotate(-45deg) scale(0);
      transition: transform 0.15s ease;
    }
    #custom-checkbox input:checked + #checkmark {
      background: linear-gradient(135deg, #6a11cb, #2575fc);
      border-color: transparent;
    }
    #custom-checkbox input:checked + #checkmark::after {
      transform: rotate(-45deg) scale(1);
    }
    #custom-checkbox:hover #checkmark {
      border-color: rgba(255,255,255,0.6);
    }

    @keyframes shake {
      0%   { transform: translateX(0); }
      20%  { transform: translateX(-5px); }
      40%  { transform: translateX(5px); }
      60%  { transform: translateX(-4px); }
      80%  { transform: translateX(4px); }
      100% { transform: translateX(0); }
    }
  `;

		shadow.appendChild(style);

		const container = document.createElement('div');
		container.innerHTML = `
  <div id='main-wrapper'>
    <div id="overlay"></div>
    <div id="banner-wrapper">
      <button id="widget-close" aria-label="Закрыть">
        <svg viewBox="0 0 24 24" fill="none">
          <line x1="6" y1="6" x2="18" y2="18"/>
          <line x1="18" y1="6" x2="6" y2="18"/>
        </svg>
      </button>

      <div id="banner-content">
        <div id='control-wrapper'>
          <h1 id='title-widget'>${config.title}</h1>
          <p id='subtitle-widget'>${config.subtitle}</p>
          ${config.nameFieldActive ? `<input type="text"  placeholder="✦  Ваше имя"    id="name-input"  autocomplete="name" />` : ``}
          ${config.phoneFieldActive ? `<input type="tel"   placeholder="✦  Ваш телефон" id="phone-input" autocomplete="tel" />` : ``}
          ${config.emailFieldActive ? `<input type="email" placeholder="✦  Ваш email"   id="email-input" autocomplete="email" />` : ``}
          ${
						config.checkboxPolicyActive
							? `
            <label id="custom-checkbox">
              <input type="checkbox" id="policy-input" />
              <span id="checkmark"></span>
              <span id="checkbox-text">
                <a id='link-consent' href='${config.linkConsentText}' target='_blank' rel='noopener noreferrer'>Согласен</a> на обработку персональных данных
              </span>
            </label>`
							: ``
					}
          <button type='button' id="spin">
            <span style="margin-right:6px">🎰</span>${config.startBtnText}
          </button>
        </div>

        <div id="wheel-wrapper">
          <div id="wheel-arrow"></div>
          <svg viewBox="0 0 300 300" id="wheel-svg">
            <defs>
              <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
                <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="rgba(0,0,0,0.45)" />
              </filter>
              <filter id="text-shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="rgba(0,0,0,0.5)" />
              </filter>
              <linearGradient id="sector-shine" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(255,255,255,0.12)" />
                <stop offset="60%" stop-color="rgba(255,255,255,0)" />
              </linearGradient>
            </defs>
            <g class="wheel" id="wheel"></g>
          </svg>
        </div>
      </div>

      ${config.developInfoActive ? `<div id='dev-info'>Сделано в&nbsp;<a id='dev-info-text' href='https://winwidget.ru'>winwidget.ru</a></div>` : ``}
    </div>
  </div>
`;

		shadow.appendChild(container);

		const EMAIL_REGEXP =
			/^(([^<>()[\].,;:\s@"]+(\.[^<>()[\].,;:\s@"]+)*)|(".+"))@(([^<>()[\].,;:\s@"]+\.)+[^<>()[\].,;:\s@"]{2,})$/iu;

		const overlay = shadow.querySelector('#overlay');
		const mainWrapper = shadow.querySelector('#main-wrapper');
		const wheelWrapper = shadow.querySelector('#wheel-wrapper');
		const bannerWrapper = shadow.querySelector('#banner-wrapper');
		const wheel = shadow.querySelector('#wheel');
		const closeBtn = shadow.querySelector('#widget-close');
		const startBtn = shadow.querySelector('#spin');
		const wheelArrow = shadow.querySelector('#wheel-arrow');
		const title = shadow.querySelector('#title-widget');
		const subtitle = shadow.querySelector('#subtitle-widget');
		const policy = shadow.querySelector('#custom-checkbox');
		const CENTER = 150;
		const RADIUS = 150;
		let currentRotation = 0;
		let lastWin = null;

		// Устанавливаем цвет фона виджета
		bannerWrapper.style.background = config.bgColor;

		// Цвет кнопки старта
		if (config.buttonColor) {
			startBtn.style.background = config.buttonColor;
			startBtn.style.boxShadow = `0 4px 20px ${config.buttonColor}80, inset 0 1px 0 rgba(255,255,255,0.15)`;
		}

		/************************ БАРАБАН ************************/
		// Вставка стрелки SVG
		if (config.arrowSVG) {
			wheelArrow.innerHTML = `<svg viewBox="0 0 20 24">${config.arrowSVG}</svg>`;
		}

		// Создание SVG-сектора
		function createSectorPath(startAngle, endAngle) {
			const rad = Math.PI / 180;
			const x1 = CENTER + RADIUS * Math.cos(startAngle * rad);
			const y1 = CENTER + RADIUS * Math.sin(startAngle * rad);
			const x2 = CENTER + RADIUS * Math.cos(endAngle * rad);
			const y2 = CENTER + RADIUS * Math.sin(endAngle * rad);
			const largeArc = endAngle - startAngle > 180 ? 1 : 0;
			return `M ${CENTER} ${CENTER} L ${x1} ${y1} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x2} ${y2} Z`;
		}

		// Центральный элемент колеса
		function renderCenter() {
			if (config.centerSVG) {
				// Создаём группу для трансформации
				const g = document.createElementNS(
					'http://www.w3.org/2000/svg',
					'g'
				);

				// Здесь центрируем SVG
				g.setAttribute('transform', `translate(${CENTER}, ${CENTER})`);

				// Создаём временный контейнер для парсинга SVG
				const temp = document.createElement('div');
				temp.innerHTML = config.centerSVG.trim();
				const svgElement = temp.firstChild;

				// Определяем размеры SVG
				const width = svgElement.getAttribute('width') || 40;
				const height = svgElement.getAttribute('height') || 40;

				// Смещаем SVG так, чтобы его центр совпадал с (0,0)
				svgElement.setAttribute('x', -width / 2);
				svgElement.setAttribute('y', -height / 2);

				g.appendChild(svgElement);
				wheel.appendChild(g);
			} else {
				const ns = 'http://www.w3.org/2000/svg';
				const defs = document.createElementNS(ns, 'defs');
				const grad = document.createElementNS(ns, 'radialGradient');
				grad.setAttribute('id', 'center-grad');
				grad.setAttribute('cx', '35%');
				grad.setAttribute('cy', '35%');
				const s1 = document.createElementNS(ns, 'stop');
				s1.setAttribute('offset', '0%');
				s1.setAttribute('stop-color', '#ffffff');
				const s2 = document.createElementNS(ns, 'stop');
				s2.setAttribute('offset', '100%');
				s2.setAttribute('stop-color', config.centerColor);
				grad.appendChild(s1);
				grad.appendChild(s2);
				defs.appendChild(grad);
				wheel.appendChild(defs);

				// Outer glow ring
				const ring = document.createElementNS(ns, 'circle');
				ring.setAttribute('cx', CENTER);
				ring.setAttribute('cy', CENTER);
				ring.setAttribute('r', 26);
				ring.setAttribute('fill', 'none');
				ring.setAttribute('stroke', 'rgba(255,255,255,0.2)');
				ring.setAttribute('stroke-width', '3');
				wheel.appendChild(ring);

				// Center button
				const centerCircle = document.createElementNS(ns, 'circle');
				centerCircle.setAttribute('cx', CENTER);
				centerCircle.setAttribute('cy', CENTER);
				centerCircle.setAttribute('r', 22);
				centerCircle.setAttribute('fill', 'url(#center-grad)');
				centerCircle.setAttribute('stroke', 'rgba(255,255,255,0.35)');
				centerCircle.setAttribute('stroke-width', '1.5');
				centerCircle.setAttribute('filter', 'url(#shadow)');
				wheel.appendChild(centerCircle);

				// Shine dot
				const shine = document.createElementNS(ns, 'circle');
				shine.setAttribute('cx', CENTER - 6);
				shine.setAttribute('cy', CENTER - 6);
				shine.setAttribute('r', 4);
				shine.setAttribute('fill', 'rgba(255,255,255,0.45)');
				wheel.appendChild(shine);
			}
		}

		// Отрисовка колеса
		function renderWheel() {
			// Делаем запрос на сервер и проверяем есть ли попытка в прокрутке барабана у клиента ? Если нет, уведомляем его об этом и называем причину отказа
			const go = true;
			if (!go) {
				title.textContent = `Попытки закончились. 🎊 Вы выйграли: Скидка 1%`;
				subtitle.textContent = 'Колесо можно крутить раз в неделю!';
				config.nameFieldActive && inputName?.remove();
				config.phoneFieldActive && inputPhone?.remove();
				config.emailFieldActive && inputEmail?.remove();
				startBtn.remove();
				config.checkboxPolicyActive && policy?.remove();
				wheelWrapper.classList.add('blur');
			}

			wheel.innerHTML = '';
			const count = config.sectors.length;
			const angleStep = 360 / count;

			config.sectors.forEach((sector, i) => {
				const start = i * angleStep - 90;
				const end = start + angleStep;
				const midAngle = start + angleStep / 2;

				const g = document.createElementNS(
					'http://www.w3.org/2000/svg',
					'g'
				);
				g.classList.add('sector');

				// сектор
				const path = document.createElementNS(
					'http://www.w3.org/2000/svg',
					'path'
				);
				path.setAttribute('d', createSectorPath(start, end));
				path.setAttribute('fill', sector.color);
				path.setAttribute('stroke', 'rgba(0,0,0,0.18)');
				path.setAttribute('stroke-width', '1.5');
				g.appendChild(path);

				// Subtle shine overlay per sector
				const shinePath = document.createElementNS(
					'http://www.w3.org/2000/svg',
					'path'
				);
				shinePath.setAttribute('d', createSectorPath(start, end));
				shinePath.setAttribute('fill', 'url(#sector-shine)');
				shinePath.setAttribute('pointer-events', 'none');
				g.appendChild(shinePath);

				// текст
				const text = document.createElementNS(
					'http://www.w3.org/2000/svg',
					'text'
				);
				const distanceFromCenter = RADIUS * 0.62;
				const tx =
					CENTER +
					distanceFromCenter * Math.cos((midAngle * Math.PI) / 180);
				const ty =
					CENTER +
					distanceFromCenter * Math.sin((midAngle * Math.PI) / 180);
				text.setAttribute('x', tx);
				text.setAttribute('y', ty);
				text.setAttribute('text-anchor', 'middle');
				text.setAttribute('dominant-baseline', 'middle');
				text.setAttribute(
					'transform',
					`rotate(${midAngle}, ${tx}, ${ty})`
				);
				text.style.fontFamily = "'Arial', sans-serif";
				text.style.fontWeight = '700';
				text.style.fill = sector.textColor;
				text.style.fontSize = `${Math.max(10, parseInt(sector.fontSize) || 14)}px`;
				text.setAttribute('filter', 'url(#text-shadow)');
				text.textContent = sector.label;

				g.appendChild(text);
				wheel.appendChild(g);
			});

			// Внешняя рамка с градиентом
			const outerCircle = document.createElementNS(
				'http://www.w3.org/2000/svg',
				'circle'
			);
			outerCircle.setAttribute('cx', CENTER);
			outerCircle.setAttribute('cy', CENTER);
			outerCircle.setAttribute('r', RADIUS + config.borderWidth / 2);
			outerCircle.setAttribute('fill', 'none');
			outerCircle.setAttribute('stroke', config.borderColor);
			outerCircle.setAttribute('stroke-width', config.borderWidth);
			outerCircle.setAttribute('filter', 'url(#shadow)');
			wheel.appendChild(outerCircle);

			// Внутренний блик-кольцо
			const innerRing = document.createElementNS(
				'http://www.w3.org/2000/svg',
				'circle'
			);
			innerRing.setAttribute('cx', CENTER);
			innerRing.setAttribute('cy', CENTER);
			innerRing.setAttribute('r', RADIUS - 2);
			innerRing.setAttribute('fill', 'none');
			innerRing.setAttribute('stroke', 'rgba(255,255,255,0.12)');
			innerRing.setAttribute('stroke-width', '2');
			wheel.appendChild(innerRing);

			// центральный элемент (круг или SVG)
			renderCenter();
		}

		// Выбор призового сектора по весам
		function weightedRandom(sectors) {
			const total = sectors.reduce((sum, s) => sum + s.probability, 0);
			let r = Math.random() * total;
			for (let i = 0; i < sectors.length; i++) {
				r -= sectors[i].probability;
				if (r <= 0) return i;
			}
		}

		// Вращение колеса
		function spinStartAnimate() {
			try {
				const _playedKey =
					'winwidget_played_' +
					config._token +
					(config.spinResetToken ? '_' + config.spinResetToken : '');
				localStorage.setItem(_playedKey, Date.now().toString());
			} catch (e) {}
			const winIndex = weightedRandom(config.sectors);
			lastWin = config.sectors[winIndex];
			const count = config.sectors.length;
			const anglePerSector = 360 / count;
			const midAngleSVG =
				-90 + winIndex * anglePerSector + anglePerSector / 2;
			const targetAngle = 360 * 6 - midAngleSVG;

			currentRotation = targetAngle;

			wheel.style.transition = `transform 4s cubic-bezier(.17,.67,.3,1)`;
			wheel.style.transform = `rotate(${currentRotation}deg)`;

			setTimeout(() => swingEffect(targetAngle, winIndex), 4200);
		}

		// Завершающее колебание стрелки ±5°
		function swingEffect(baseAngle, winIndex) {
			const swingAmplitude = 5;
			const swingDuration = 1000;
			const startTime = Date.now();

			function animate() {
				const elapsed = Date.now() - startTime;
				const progress = Math.min(elapsed / swingDuration, 1);
				const swingRotation =
					Math.sin(progress * Math.PI * 4) *
					swingAmplitude *
					(1 - progress);

				wheel.style.transition = 'transform 0s';
				wheel.style.transform = `rotate(${baseAngle + swingRotation}deg)`;

				if (progress < 1) {
					requestAnimationFrame(animate);
				} else {
					//Анимация выйгрыша
					if (config.confettiEffectActive) {
						confettiExplosioneEffect({
							container: bannerWrapper,
							count: 180
						});
						setTimeout(
							() => confettiFallsEffect({ container: bannerWrapper }),
							600
						);
					}

					//Изменение title виджета на название приза
					title.textContent = `🎊 Вы выиграли: ${config.sectors[winIndex].label}`;

					//Скрываем инпуты и кнопки
					showElements();
				}
			}
			animate();
			sendResultToServer();
		}

		/************************ Изменение виджета после выйгрыша ************************/
		function showElements() {
			config.winningAdviceActive
				? (subtitle.textContent = config.winningAdviceText)
				: subtitle.remove();
			config.nameFieldActive && inputName?.remove();
			config.phoneFieldActive && inputPhone?.remove();
			config.emailFieldActive && inputEmail?.remove();
			startBtn.remove();
			config.checkboxPolicyActive && policy?.remove();
		}
		/************************/

		/************************ ИНПУТЫ ************************/
		//Опциональные инпуты
		const inputName = config.nameFieldActive
			? shadow.getElementById('name-input')
			: null;
		const inputPhone = config.phoneFieldActive
			? shadow.getElementById('phone-input')
			: null;
		const inputEmail = config.emailFieldActive
			? shadow.getElementById('email-input')
			: null;
		const inputCheckboxPolicy = config.checkboxPolicyActive
			? shadow.getElementById('policy-input')
			: null;

		//Инпут с номером телефона
		const MASK = '+7 (9__) ___-__-__';
		let digits = ''; // 9 цифр без 7и9

		//Рендер маски номера телефона
		function renderMask() {
			let result = MASK.split('');
			let d = 0;

			for (let i = 0; i < result.length; i++) {
				if (result[i] === '_' && digits[d]) {
					result[i] = digits[d++];
				}
			}

			inputPhone.value = result.join('');
			moveCursor();
		}

		function moveCursor() {
			const pos = inputPhone.value.indexOf('_');
			inputPhone.setSelectionRange(
				pos === -1 ? inputPhone.value.length : pos,
				pos === -1 ? inputPhone.value.length : pos
			);
		}

		// Фокус на инпуте с номером телефона
		config.phoneFieldActive &&
			inputPhone.addEventListener('focus', () => {
				if (!inputPhone.value) {
					renderMask();
				}
			});

		// Ввод и удаление в инпуте с номером телефона
		function handleKeydownInputPhone(e) {
			// цифры
			if (/\d/.test(e.key)) {
				if (digits.length < 9) {
					digits += e.key;
					renderMask();
				}
				e.preventDefault();
				return;
			}

			// backspace
			if (e.key === 'Backspace') {
				digits = digits.slice(0, -1);
				renderMask();
				e.preventDefault();
				return;
			}

			// служебные клавиши
			if (!['ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
				e.preventDefault();
			}
		}

		// Вставка номера телефона из буфера обмена
		function handlePaste(text) {
			const digitsOnly = text.replace(/\D/g, '');
			// убираем ведущие 7/8 и ведущую 9 (зафиксирована в маске), берём последние 9 цифр
			const stripped = digitsOnly.replace(/^[78]?9?/, '');
			digits = stripped.slice(0, 9);
			renderMask();
		}

		//Анимация инпутов при ошибке ввода
		function shakeInput(element) {
			//сила качания
			const distance = 6;
			// количество колебаний
			const shakes = 15;
			// общая длительность (мс)
			const duration = 350;

			let start = null;

			function animate(time) {
				if (!start) start = time;
				const progress = time - start;
				const percent = progress / duration;

				const offset =
					Math.sin(percent * shakes * Math.PI * 2) *
					distance *
					(1 - percent);

				element.style.transform = `translateX(${offset}px)`;

				if (progress < duration) {
					requestAnimationFrame(animate);
				} else {
					element.style.transform = '';
				}
			}

			requestAnimationFrame(animate);
		}

		//Валидация инпутов
		function validate() {
			let isValid = true;

			if (!config.devModeActive) {
				if (config.nameFieldActive && !inputName.value.trim().length) {
					shakeInput(inputName);
					isValid = false;
				}

				if (config.phoneFieldActive && digits.length !== 9) {
					shakeInput(inputPhone);
					isValid = false;
				}

				if (
					config.emailFieldActive &&
					!EMAIL_REGEXP.test(inputEmail.value)
				) {
					shakeInput(inputEmail);
					isValid = false;
				}

				if (config.checkboxPolicyActive && !inputCheckboxPolicy.checked) {
					shakeInput(policy);
					isValid = false;
				}
			}

			return isValid;
		}

		// Потеря фокуса c инпута с именем
		function handleBlurInputName() {
			if (!inputName.value.length) {
				return;
			}

			validate();
		}

		// Потеря фокуса c инпута с номером телефона
		function handleBlurInputPhone() {
			if (!digits.length) {
				inputPhone.value = '';
				return;
			}

			validate();
		}

		// Потеря фокуса c инпута с email
		function handleBlurInputEmail() {
			if (!inputEmail.value.length) {
				return;
			}

			validate();
		}
		/************************/

		/************************ Получение и форматирование данных с инпутов ************************/
		//Получаем имя пользователя
		function getName() {
			return config.nameFieldActive ? inputName.value : null;
		}

		// Получение чистого номера для отправки на бэк
		function getFormatPhone() {
			return digits.length === 9 ? `79${digits}` : null;
		}

		//Получаем email пользователя
		function getEmail() {
			return config.emailFieldActive ? inputEmail.value : null;
		}

		async function pushBtn() {
			const isValid = validate();

			if (!isValid) {
				return;
			}

			startBtn.disabled = true;
			startBtn.style.opacity = '0.6';
			startBtn.style.cursor = 'not-allowed';

			spinStartAnimate();
		}
		/************************/

		/************************ Отправка на сервер ************************/
		async function sendResultToServer() {
			const payload = {
				phone: getFormatPhone(),
				email: getEmail(),
				name: getName(),
				bonus: lastWin?.label
			};

			try {
				await fetch(`${API_BASE}/widget/${config._token}/lead`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload)
				});
				firePixelEvent('ip3_send');
			} catch (e) {
				console.error('[winwidget] Failed to send lead:', e);
			}
		}
		/************************/

		/************************ АНИМАЦИЯ КОНФЕТИ ************************/
		//Конфетти с эффектом падения сверху
		function confettiFallsEffect({ container, count = 60 }) {
			const COLORS = [
				'#FFD700',
				'#FF6B9D',
				'#7BED9F',
				'#70A1FF',
				'#ECCC68',
				'#ffffff',
				'#A29BFE',
				'#FF6348'
			];
			const shapes = ['square', 'circle', 'streamer', 'diamond'];
			const rect = container.getBoundingClientRect();

			for (let i = 0; i < count; i++) {
				const delay = Math.random() * 1200;
				setTimeout(() => {
					const el = document.createElement('div');
					const shape = shapes[Math.floor(Math.random() * shapes.length)];
					el.classList.add('confetti', shape);
					el.style.backgroundColor =
						COLORS[Math.floor(Math.random() * COLORS.length)];
					const size = Math.random() * 6 + 5;
					if (shape !== 'streamer') {
						el.style.width = `${size}px`;
						el.style.height = `${size}px`;
					}
					el.style.left = Math.random() * rect.width + 'px';
					el.style.top = '-20px';
					el.style.opacity = '1';
					container.appendChild(el);

					const duration = 3.5 + Math.random() * 2;
					const swingX = (Math.random() - 0.5) * 60;
					const rotate =
						Math.random() * 720 * (Math.random() < 0.5 ? 1 : -1);
					requestAnimationFrame(() => {
						el.style.transition = `top ${duration}s linear, transform ${duration}s ease-out, opacity 0.8s ease-out ${(duration - 0.9).toFixed(1)}s`;
						el.style.top = `${rect.height + 20}px`;
						el.style.transform = `translateX(${swingX}px) rotate(${rotate}deg)`;
						el.style.opacity = '0';
					});
					setTimeout(() => el.remove(), duration * 1000 + 300);
				}, delay);
			}
		}

		function confettiExplosioneEffect({ container, count = 160 }) {
			const COLORS = [
				'#FFD700',
				'#FFC200',
				'#FF6B9D',
				'#FF4757',
				'#7BED9F',
				'#2ED573',
				'#70A1FF',
				'#1E90FF',
				'#ECCC68',
				'#ffffff',
				'#A29BFE',
				'#6C5CE7',
				'#FF6348',
				'#FFA502'
			];
			const shapes = [
				'square',
				'circle',
				'streamer',
				'diamond',
				'square',
				'circle'
			];
			const rect = container.getBoundingClientRect();
			const W = rect.width;
			const H = rect.height;

			// 3 волны с нарастанием
			const waves = [
				{
					delay: 0,
					origins: [
						{ x: W * 0.5, y: H * 0.35, n: Math.floor(count * 0.45) }
					]
				},
				{
					delay: 180,
					origins: [
						{ x: W * 0.2, y: H * 0.25, n: Math.floor(count * 0.25) },
						{ x: W * 0.8, y: H * 0.25, n: Math.floor(count * 0.25) }
					]
				},
				{
					delay: 380,
					origins: [
						{ x: W * 0.5, y: H * 0.2, n: Math.floor(count * 0.2) },
						{ x: W * 0.1, y: H * 0.4, n: Math.floor(count * 0.1) },
						{ x: W * 0.9, y: H * 0.4, n: Math.floor(count * 0.1) }
					]
				}
			];

			waves.forEach(({ delay, origins }) => {
				setTimeout(() => {
					origins.forEach(({ x, y, n }) => {
						for (let i = 0; i < n; i++) {
							const el = document.createElement('div');
							const shape =
								shapes[Math.floor(Math.random() * shapes.length)];
							el.classList.add('confetti', shape);
							el.style.backgroundColor =
								COLORS[Math.floor(Math.random() * COLORS.length)];
							const size = Math.random() * 8 + 5;
							if (shape !== 'streamer') {
								el.style.width = `${size}px`;
								el.style.height = `${size}px`;
							}
							el.style.left = `${x + (Math.random() - 0.5) * 16}px`;
							el.style.top = `${y + (Math.random() - 0.5) * 16}px`;
							el.style.opacity = '1';
							container.appendChild(el);

							// случайный угол: верхняя полусфера с небольшим вылетом вниз
							const angle =
								(-90 + (Math.random() - 0.5) * 200) * (Math.PI / 180);
							const power = 120 + Math.random() * 220;
							const vx = Math.cos(angle) * power;
							const vy = Math.sin(angle) * power;
							const r0 = Math.random() * 360;
							const r1 = r0 + (Math.random() * 900 - 450);
							const phase1 = 380 + Math.random() * 200;

							requestAnimationFrame(() => {
								el.style.transition = `transform ${phase1}ms cubic-bezier(.15,.8,.25,1)`;
								el.style.transform = `translate(${vx}px,${vy}px) rotate(${r0}deg)`;
							});

							setTimeout(() => {
								const fallY = H - y + Math.abs(vy) + 80;
								const drift = (Math.random() - 0.5) * 100;
								const phase2 = 1800 + Math.random() * 900;
								el.style.transition = `transform ${phase2}ms cubic-bezier(.1,.5,.3,1), opacity ${Math.round(phase2 * 0.35)}ms ease-out ${Math.round(phase2 * 0.65)}ms`;
								el.style.transform = `translate(${vx + drift}px,${vy + fallY}px) rotate(${r1}deg)`;
								el.style.opacity = '0';
							}, phase1);

							setTimeout(() => el.remove(), phase1 + 2800);
						}
					});
				}, delay);
			});
		}
		/************************/

		//Инициализация
		renderWheel();

		//Обработчики событий
		config.nameFieldActive &&
			inputName.addEventListener('blur', handleBlurInputName);
		config.phoneFieldActive &&
			inputPhone.addEventListener('blur', handleBlurInputPhone);
		config.phoneFieldActive &&
			inputPhone.addEventListener('paste', e => {
				e.preventDefault();
				const pastedText = (
					e.clipboardData || window.clipboardData
				).getData('text');
				handlePaste(pastedText);
			});
		config.phoneFieldActive &&
			inputPhone.addEventListener('keydown', handleKeydownInputPhone);
		config.emailFieldActive &&
			inputEmail.addEventListener('blur', handleBlurInputEmail);
		closeBtn.addEventListener('click', closeWidget);
		startBtn.addEventListener('click', pushBtn);
		giftBtn.addEventListener('click', openWidget);
		overlay.addEventListener('click', closeWidget);

		// Ограничение попыток (localStorage + IP)
		try {
			const playedKey =
				'winwidget_played_' +
				config._token +
				(config.spinResetToken ? '_' + config.spinResetToken : '');
			const storedTs = localStorage.getItem(playedKey);
			let hasPlayed = config.hasPlayedByIp === true;
			if (!hasPlayed && storedTs) {
				const cooldownMs =
					(config.spinCooldownDays || 0) * 24 * 60 * 60 * 1000;
				if (cooldownMs === 0) {
					hasPlayed = true; // один раз навсегда
				} else {
					hasPlayed = Date.now() - parseInt(storedTs, 10) < cooldownMs;
				}
			}
			if (hasPlayed) {
				if (config.hideIfPlayed) {
					// Полностью скрываем виджет и кнопку
					giftBtn.style.display = 'none';
					stopGiftAnimation();
					const host = document.getElementById('wheel-widget-host');
					if (host) host.style.display = 'none';
					return;
				}
				const controlWrapper = shadow.querySelector('#control-wrapper');
				if (controlWrapper) {
					controlWrapper.innerHTML = `
					<h1 id='title-widget' style='text-align:center;overflow-wrap:break-word;word-break:break-word'>${config.alreadyPlayedTitle}</h1>
					<p id='subtitle-widget' style='text-align:center;margin-top:8px'>${config.alreadyPlayedSubtitle}</p>
				`;
				}
			}
		} catch (e) {}

		if (config.autoOpenSeconds) {
			setTimeout(openWidget, config.autoOpenSeconds * 1000);
		}

		// Apply button position and pulse from config
		_giftPulseEnabled = config.buttonPulse !== false;
		giftBtn.style.bottom = `${config.buttonBottom ?? 3}%`;
		if (config.buttonSide === 'left') {
			giftBtn.style.right = 'auto';
			giftBtn.style.left = '28px';
		} else {
			giftBtn.style.left = 'auto';
			giftBtn.style.right = '28px';
		}

		if (window.winwidgetAutoOpen) {
			closeBtn.style.display = 'none';
			overlay.style.pointerEvents = 'none';
			setTimeout(openWidget, 300);
		} else {
			// Показываем кнопку только сейчас — конфиг загружен, все проверки пройдены
			giftBtn.style.display = '';
			stopGiftAnimation();
			startGiftAnimation();
		}
	} // end initWidget

	/************************ Загрузка конфига с сервера ************************/
	function mapServerConfig(server, token) {
		const raffleBonus = (server.bonuses || [])
			.filter(b => b.isInRaffle)
			.sort((a, b) => a.order - b.order);

		const sectors =
			raffleBonus.length > 0
				? raffleBonus.map((bonus, i) => {
						const sectorColor =
							bonus.color || (i % 2 === 0 ? server.color : '#ffffff');
						const isDark = sectorColor !== '#ffffff';
						return {
							label: bonus.text,
							probability: bonus.neverWin ? 0 : (bonus.probability ?? 1),
							color: sectorColor,
							textColor: isDark ? '#ffffff' : '#000000',
							fontSize: '14'
						};
					})
				: [
						{
							label: 'Приз 1',
							probability: 1,
							color: server.color,
							textColor: '#ffffff',
							fontSize: '14'
						},
						{
							label: 'Приз 2',
							probability: 1,
							color: '#ffffff',
							textColor: '#000000',
							fontSize: '14'
						}
					];

		const dc = server.dataCollection;
		return {
			_token: token,
			widgetColor: server.color,
			bgColor: server.bgColor || server.color,
			sectors,
			centerColor: server.centerColor || '#ffffff',
			centerSVG: null,
			arrowColor: server.arrowColor || '#ffcc00',
			arrowSVG: (() => {
				const c = server.arrowColor || '#ffcc00';
				return `<polygon points="0,12 18,5 18,19" fill="${c}" filter="url(#arrow-shadow)"/><defs><filter id="arrow-shadow"><feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="rgba(0,0,0,0.5)"/></filter></defs>`;
			})(),
			borderColor: server.color,
			borderWidth: 8,
			lineColor: '#000000',
			title: server.headline || 'Испытайте удачу',
			subtitle:
				server.subheadline ||
				(() => {
					const dc = (server.dataCollection || 'PHONE').toUpperCase();
					if (dc === 'EMAIL')
						return 'Введите свою почту, чтобы выиграть приз';
					if (dc === 'PHONE_AND_EMAIL')
						return 'Введите свой номер телефона и почту, чтобы выиграть приз';
					if (dc === 'NONE') return 'Крутите барабан, чтобы выиграть приз';
					return 'Введите свой номер телефона, чтобы выиграть приз';
				})(),
			confettiEffectActive: true,
			confettiExplosioneEffect: true,
			confettiFallsEffect: false,
			winningAdviceActive: !!server.winMessage,
			winningAdviceText: server.winMessage || '',
			phoneFieldActive: dc === 'PHONE' || dc === 'PHONE_AND_EMAIL',
			nameFieldActive: dc !== 'NONE',
			emailFieldActive: dc === 'EMAIL' || dc === 'PHONE_AND_EMAIL',
			checkboxPolicyActive: true,
			startBtnText: server.buttonText || 'Крутить!',
			linkConsentText:
				server.privacyPolicyUrl ||
				'https://winwidget.ru/legal-documentation/consent-processing',
			linkPolicyText: server.privacyPolicyUrl || '#',
			linkOffer: '#',
			developInfoActive: true,
			devModeActive: false,
			autoOpenSeconds: server.autoOpenSeconds || null,
			spinDuration: server.spinDuration || 5,
			buttonSide: server.buttonSide || 'right',
			buttonPulse: server.buttonPulse !== false,
			buttonBottom: server.buttonBottom ?? 3,
			alreadyPlayedTitle:
				server.alreadyPlayedTitle || '🎉 Вы уже участвовали!',
			alreadyPlayedSubtitle:
				server.alreadyPlayedSubtitle ||
				'Каждый посетитель может крутить колесо только один раз',
			hideIfPlayed: server.hideIfPlayed === true,
			buttonColor: server.buttonColor || '',
			spinCooldownDays: server.spinCooldownDays ?? 0,
			spinResetToken: server.spinResetToken || '',
			hasPlayedByIp: server.hasPlayedByIp === true,
			yandexMetrikaId: server.yandexMetrikaId || null,
			vkPixelId: server.vkPixelId || null,
			roistatEnabled: server.roistatEnabled === true
		};
	}

	function showDisabledPage() {
		const el = document.createElement('div');
		el.style.cssText = [
			'position:fixed',
			'inset:0',
			'display:flex',
			'flex-direction:column',
			'align-items:center',
			'justify-content:center',
			'background:#0d0d1a',
			'color:#fff',
			'font-family:sans-serif',
			'text-align:center',
			'padding:24px',
			'z-index:2147483647'
		].join(';');
		el.innerHTML = [
			'<div style="font-size:3rem;margin-bottom:16px">🔒</div>',
			'<h1 style="font-size:1.4rem;font-weight:700;margin-bottom:10px">Виджет отключён</h1>',
			'<p style="font-size:0.95rem;color:#8080a0;margin-bottom:28px;max-width:320px">',
			'Этот виджет в данный момент отключён. Включите его в личном кабинете.',
			'</p>',
			'<a href="https://winwidget.ru/widgets" ',
			'style="display:inline-block;padding:11px 28px;background:#4705fb;color:#fff;',
			'border-radius:10px;font-weight:700;font-size:0.9rem;text-decoration:none;',
			'transition:background 0.2s" ',
			'onmouseover="this.style.background=\'#5a1aff\'" ',
			'onmouseout="this.style.background=\'#4705fb\'">',
			'Перейти в кабинет',
			'</a>'
		].join('');
		document.body.appendChild(el);
	}

	async function bootstrap() {
		const token = _currentScript?.dataset?.key || window.winwidget;
		if (!token) {
			console.warn(
				'[winwidget] Token not set. Use data-key attribute: <script src="..." data-key="YOUR_TOKEN"> or set window.winwidget before the script.'
			);
			return;
		}

		try {
			const res = await fetch(`${API_BASE}/widget/${token}/config`);
			if (!res.ok) {
				console.warn(
					`[winwidget] Widget not found or inactive (${res.status})`
				);
				return;
			}
			const server = await res.json();
			if (!server.isActive) {
				console.warn('[winwidget] Widget is inactive');
				if (window.winwidgetAutoOpen) {
					showDisabledPage();
				}
				return;
			}
			initWidget(mapServerConfig(server, token));
		} catch (e) {
			console.error('[winwidget] Failed to load config:', e);
		}
	}

	bootstrap();
})();
/************************/
