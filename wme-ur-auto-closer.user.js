// ==UserScript==
// @name         WME UR Auto-Closer
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Автозакриття UR з плаваючою кнопкою та циклічним перезапуском поки є що закривати
// @author       Andrey
// @include      /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // КОНФІГУРАЦІЯ
    // =========================================================================

    // Мінімальна кількість днів після нашого коментаря для автозакриття
    const DAYS_LIMIT = 14;

    // Тригер-фраза в останньому коментарі → закрити як not-identified
    const TARGET_PHRASE = "Помилка без коментарів буде закрита як нез'ясована";

    // Статус закриття для UR що відповідають умовам
    const CLOSE_AS = 'not-identified';

    // Пауза між циклами (ms) — чекаємо поки WME завантажить нові UR після закриття попередніх
    const CYCLE_PAUSE_MS = 4000;

    // =========================================================================

    const SCRIPT_NAME = 'UR-Closer';
    let sdk = null;
    let isRunning = false;
    let ui = null; // посилання на елементи UI

    // -------------------------------------------------------------------------
    // Логування — виводить в консоль і в UI-панель
    // -------------------------------------------------------------------------
    function log(msg, style) {
        style
            ? console.log(`%c[${SCRIPT_NAME}] ${msg}`, style)
            : console.log(`[${SCRIPT_NAME}] ${msg}`);
        if (ui) appendToLog(msg);
    }
    function logErr(msg, e) {
        const full = e ? `${msg}: ${e}` : msg;
        console.error(`[${SCRIPT_NAME}] ✖ ${full}`);
        if (ui) appendToLog(`✖ ${full}`);
    }

    // -------------------------------------------------------------------------
    // Один цикл обробки: перебирає всі UR у viewport і закриває підходящі.
    // Повертає кількість закритих у цьому циклі.
    // -------------------------------------------------------------------------
    async function runCycle() {
        const now = Date.now();
        const limitMs = DAYS_LIMIT * 24 * 60 * 60 * 1000;

        const allUrs = Object.values(sdk.DataModel.MapUpdateRequests.getAll());
        const openUrs = allUrs.filter(u => u.isOpen);

        log(`Цикл: ${openUrs.length} відкритих (з ${allUrs.length} у viewport)`);
        ui && updateStatus(`Аналіз ${openUrs.length} UR...`);

        let closedThisCycle = 0;

        for (const ur of openUrs) {
            if (!isRunning) break; // зупинка по кнопці

            try {
                const details = await sdk.DataModel.MapUpdateRequests.getUpdateRequestDetails({
                    mapUpdateRequestId: ur.id,
                });

                const comments = details?.comments
                               || details?.updateRequestDetails?.comments
                               || [];

                if (comments.length === 0) continue;

                const lastMsg = comments[comments.length - 1];
                const text = (lastMsg.text || lastMsg.comment || lastMsg.body || '')
                    .replace(/\s+/g, ' ').trim();

                if (!text.includes(TARGET_PHRASE)) continue;

                const msgDate = lastMsg.createdOn ?? lastMsg.date ?? null;
                if (!msgDate) continue;

                const diffMs = now - msgDate;
                const daysPast = Math.floor(diffMs / 86400000);

                if (diffMs < limitMs) continue; // ще не час

                log(`ЗАКРИВАЮ #${ur.id} (${daysPast} дн.)`, 'color:#ff4500;font-weight:bold');
                ui && updateStatus(`Закриваю #${ur.id} (${daysPast} дн.)...`);

                await sdk.DataModel.MapUpdateRequests.updateResolutionState({
                    mapUpdateRequestId: ur.id,
                    resolutionState: CLOSE_AS,
                });

                log(`  ✔ #${ur.id} закрито`);
                closedThisCycle++;
                ui && incrementClosed();

            } catch (e) {
                logErr(`#${ur.id}`, e?.message || e);
            }
        }

        return closedThisCycle;
    }

    // -------------------------------------------------------------------------
    // Головний цикл: запускає runCycle() поки є що закривати,
    // потім чекає CYCLE_PAUSE_MS і повторює.
    // Зупиняється якщо isRunning = false або два цикли поспіль закрили 0 UR.
    // -------------------------------------------------------------------------
    async function runLoop() {
        let totalClosed = 0;
        let emptyRounds = 0;

        while (isRunning) {
            const closed = await runCycle();
            totalClosed += closed;

            if (closed === 0) {
                emptyRounds++;
                // Два пустих цикли поспіль = більше нічого немає
                if (emptyRounds >= 2) {
                    log(`Більше немає UR для закриття. Всього закрито: ${totalClosed}.`, 'color:green;font-weight:bold');
                    ui && updateStatus(`✅ Готово. Закрито: ${totalClosed}`);
                    break;
                }
                // Перший пустий цикл — чекаємо чи завантажяться нові UR
                log(`Пустий цикл #${emptyRounds}, чекаю ${CYCLE_PAUSE_MS / 1000}s...`);
                ui && updateStatus(`Очікую нові UR... (${CYCLE_PAUSE_MS / 1000}s)`);
                await waitForMapData();
            } else {
                emptyRounds = 0;
                // Після успішного закриття — пауза щоб WME завантажив наступну порцію UR
                log(`Закрито ${closed}. Пауза ${CYCLE_PAUSE_MS / 1000}s...`);
                ui && updateStatus(`Закрито ${closed}. Чекаю нові UR...`);
                await waitForMapData();
            }
        }

        if (!isRunning) {
            log('Зупинено вручну.');
            ui && updateStatus('⏹ Зупинено');
        }

        // Зберігаємо зміни
        if (totalClosed > 0) {
            try {
                await sdk.Editing.save();
                log('Зміни збережено.', 'color:green');
                ui && appendToLog('💾 Зміни збережено.');
            } catch (e) {
                log(`Editing.save(): ${e?.message} (може бути нормально)`);
            }
        }

        isRunning = false;
        ui && setButtonState('idle');
    }

    // -------------------------------------------------------------------------
    // Очікування wme-map-data-loaded АБО таймаут
    // -------------------------------------------------------------------------
    function waitForMapData() {
        return new Promise(resolve => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            sdk.Events.once({ eventName: 'wme-map-data-loaded' }).then(finish);
            setTimeout(finish, CYCLE_PAUSE_MS);
        });
    }

    // =========================================================================
    // UI — плаваюча кнопка з мінімальним логом
    // =========================================================================
    function createUI() {
        // Контейнер
        const panel = document.createElement('div');
        panel.id = 'ur-closer-panel';
        panel.style.cssText = `
            position: fixed;
            bottom: 60px;
            left: 16px;
            z-index: 999999;
            font-family: 'Segoe UI', system-ui, sans-serif;
            font-size: 12px;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 4px;
            pointer-events: none;
        `;

        // Лог-панель (прихована за замовчуванням)
        const logBox = document.createElement('div');
        logBox.id = 'ur-closer-log';
        logBox.style.cssText = `
            background: rgba(15,15,20,0.93);
            color: #c8d0d8;
            border: 1px solid #2a3040;
            border-radius: 8px;
            padding: 8px 10px;
            width: 280px;
            max-height: 180px;
            overflow-y: auto;
            line-height: 1.5;
            display: none;
            pointer-events: auto;
            backdrop-filter: blur(6px);
        `;

        // Рядок статусу
        const statusLine = document.createElement('div');
        statusLine.id = 'ur-closer-status';
        statusLine.style.cssText = `
            color: #6c8ebf;
            font-size: 11px;
            margin-bottom: 2px;
        `;
        statusLine.textContent = 'Готово';
        logBox.appendChild(statusLine);

        // Роздільник
        const divider = document.createElement('div');
        divider.style.cssText = 'border-top: 1px solid #2a3040; margin: 4px 0;';
        logBox.appendChild(divider);

        // Область з рядками лога
        const logLines = document.createElement('div');
        logLines.id = 'ur-closer-lines';
        logBox.appendChild(logLines);

        // Лічильник закритих
        const counter = document.createElement('div');
        counter.id = 'ur-closer-counter';
        counter.style.cssText = `
            color: #4ade80;
            font-weight: 600;
            font-size: 11px;
            margin-top: 4px;
            display: none;
        `;
        counter.textContent = 'Закрито: 0';
        logBox.appendChild(counter);

        // Основна кнопка
        const btn = document.createElement('button');
        btn.id = 'ur-closer-btn';
        btn.title = 'WME UR Auto-Closer';
        btn.style.cssText = `
            width: 44px;
            height: 44px;
            border-radius: 50%;
            border: none;
            cursor: pointer;
            background: #1a73e8;
            color: white;
            font-size: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.35);
            transition: background 0.2s, transform 0.1s;
            pointer-events: auto;
            position: relative;
            outline: none;
        `;
        btn.textContent = '🔄';

        btn.addEventListener('mouseenter', () => {
            if (!isRunning) btn.style.background = '#1557b0';
            logBox.style.display = 'block';
        });
        panel.addEventListener('mouseleave', () => {
            if (!isRunning) logBox.style.display = 'none';
        });

        btn.addEventListener('click', () => {
            if (isRunning) {
                // Зупинити
                isRunning = false;
                setButtonState('stopping');
            } else {
                // Запустити
                isRunning = true;
                closedTotal = 0;
                counter.style.display = 'block';
                counter.textContent = 'Закрито: 0';
                logLines.innerHTML = '';
                logBox.style.display = 'block';
                setButtonState('running');
                runLoop().catch(e => logErr('runLoop', e?.message));
            }
        });

        panel.appendChild(logBox);
        panel.appendChild(btn);
        document.body.appendChild(panel);

        ui = { btn, logLines, statusLine, counter, logBox };
        return ui;
    }

    let closedTotal = 0;

    function setButtonState(state) {
        if (!ui) return;
        const { btn } = ui;
        if (state === 'running') {
            btn.textContent = '⏹';
            btn.title = 'Зупинити (клік)';
            btn.style.background = '#e53935';
            btn.style.animation = 'ur-closer-pulse 1.5s infinite';
        } else if (state === 'stopping') {
            btn.textContent = '⏳';
            btn.style.background = '#f59e0b';
            btn.style.animation = 'none';
        } else {
            btn.textContent = '🔄';
            btn.title = 'Запустити UR Auto-Closer';
            btn.style.background = '#1a73e8';
            btn.style.animation = 'none';
        }
    }

    function updateStatus(msg) {
        if (ui?.statusLine) ui.statusLine.textContent = msg;
    }

    function appendToLog(msg) {
        if (!ui?.logLines) return;
        const line = document.createElement('div');
        line.style.cssText = 'padding: 1px 0; border-bottom: 1px solid #1a2030; word-break: break-all;';
        line.textContent = msg;
        ui.logLines.appendChild(line);
        // Авто-скрол вниз
        ui.logLines.scrollTop = ui.logLines.scrollHeight;
        // Обмежуємо кількість рядків
        while (ui.logLines.children.length > 60) {
            ui.logLines.removeChild(ui.logLines.firstChild);
        }
    }

    function incrementClosed() {
        if (!ui?.counter) return;
        closedTotal++;
        ui.counter.textContent = `Закрито: ${closedTotal}`;
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes ur-closer-pulse {
                0%   { box-shadow: 0 0 0 0 rgba(229,57,53,0.5); }
                70%  { box-shadow: 0 0 0 10px rgba(229,57,53,0); }
                100% { box-shadow: 0 0 0 0 rgba(229,57,53,0); }
            }
            #ur-closer-log::-webkit-scrollbar { width: 4px; }
            #ur-closer-log::-webkit-scrollbar-track { background: transparent; }
            #ur-closer-log::-webkit-scrollbar-thumb { background: #2a3040; border-radius: 2px; }
        `;
        document.head.appendChild(style);
    }

    // =========================================================================
    // Ініціалізація SDK
    // =========================================================================
    function init() {
        if (typeof window.getWmeSdk !== 'function') return;

        try {
            sdk = window.getWmeSdk({ scriptId: 'ur-closer', scriptName: 'UR Auto-Closer' });
        } catch (e) {
            console.error(`[${SCRIPT_NAME}] getWmeSdk:`, e.message);
            return;
        }

        sdk.Events.once({ eventName: 'wme-ready' }).then(() => {
            injectStyles();
            createUI();
            log('Готово. Натисніть 🔄 для запуску.');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.SDK_INITIALIZED.then(init).catch(e => console.error(`[${SCRIPT_NAME}]`, e));
        });
    } else {
        window.SDK_INITIALIZED.then(init).catch(e => console.error(`[${SCRIPT_NAME}]`, e));
    }

})();