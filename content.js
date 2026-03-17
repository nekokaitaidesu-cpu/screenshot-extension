'use strict';

// 重複注入ガード（リスナーは1回だけ登録）
if (!window.__regionSS) {
  window.__regionSS = true;

  let state = 'idle'; // idle | waiting_first | waiting_second | capturing
  let format = 'png';
  let point1 = null;

  // UI要素
  let overlayEl = null;
  let hintEl = null;
  let marker1El = null;
  let selRectEl = null;
  let coordEl = null;
  let processingEl = null;

  // ─── メッセージリスナー ───────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'startCapture') {
      if (state !== 'idle') {
        cleanupUI();
        state = 'idle';
      }
      format = msg.format || 'png';
      startCapture();
      sendResponse && sendResponse({ ok: true });
    } else if (msg.action === 'captureComplete') {
      hideProcessing();
      showToast('✅ スクリーンショットを保存しました！');
    } else if (msg.action === 'captureError') {
      hideProcessing();
      showToast('❌ エラー: ' + (msg.error || '不明なエラー'));
    }
  });

  // ─── キャプチャ開始 ──────────────────────────────
  function startCapture() {
    state = 'waiting_first';

    overlayEl = makeEl('div', `
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      z-index: 2147483647; cursor: crosshair;
      background: rgba(0,0,0,0.01);
    `);

    hintEl = makeEl('div', `
      position: fixed; top: 16px; left: 50%;
      transform: translateX(-50%);
      background: rgba(20,20,20,0.85); color: #fff;
      padding: 10px 20px; border-radius: 8px;
      font: 600 13px/1.5 -apple-system,sans-serif;
      z-index: 2147483647; pointer-events: none;
      white-space: nowrap;
      box-shadow: 0 3px 12px rgba(0,0,0,0.35);
    `);
    hintEl.textContent = '① 始点をクリック　　[ESC でキャンセル]';

    coordEl = makeEl('div', `
      position: fixed;
      background: rgba(20,20,20,0.7); color: #fff;
      font: 11px/1 monospace; padding: 3px 7px;
      border-radius: 3px; z-index: 2147483647;
      pointer-events: none; display: none;
    `);

    document.body.append(overlayEl, hintEl, coordEl);

    overlayEl.addEventListener('click', onOverlayClick, true);
    overlayEl.addEventListener('mousemove', onMouseMove);
    document.addEventListener('keydown', onKeydown, true);
  }

  // ─── マウス移動 ──────────────────────────────────
  function onMouseMove(e) {
    // 座標表示
    coordEl.style.display = 'block';
    coordEl.style.left = (e.clientX + 16) + 'px';
    coordEl.style.top  = (e.clientY + 16) + 'px';
    coordEl.textContent =
      `${Math.round(e.clientX + window.scrollX)}, ${Math.round(e.clientY + window.scrollY)}`;

    // 選択矩形プレビュー（point1確定後）
    if (state === 'waiting_second' && point1 && selRectEl) {
      const x1v = point1.docX - window.scrollX; // ビューポート内のX
      const y1v = point1.docY - window.scrollY; // ビューポート内のY
      const x = Math.min(x1v, e.clientX);
      const y = Math.min(y1v, e.clientY);
      const w = Math.abs(e.clientX - x1v);
      const h = Math.abs(e.clientY - y1v);
      selRectEl.style.left   = x + 'px';
      selRectEl.style.top    = y + 'px';
      selRectEl.style.width  = w + 'px';
      selRectEl.style.height = h + 'px';
    }
  }

  // ─── クリック ────────────────────────────────────
  function onOverlayClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const docX = e.clientX + window.scrollX;
    const docY = e.clientY + window.scrollY;

    if (state === 'waiting_first') {
      point1 = { docX, docY };
      state = 'waiting_second';

      // 始点マーカー（ドキュメント座標で絶対位置）
      marker1El = makeEl('div', `
        position: absolute;
        left: ${docX - 6}px; top: ${docY - 6}px;
        width: 12px; height: 12px;
        background: #f33; border-radius: 50%;
        box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px #f33;
        z-index: 2147483647; pointer-events: none;
      `);
      document.body.appendChild(marker1El);

      // 選択矩形プレビュー（fixed）
      selRectEl = makeEl('div', `
        position: fixed;
        border: 2px dashed rgba(255,60,60,0.9);
        background: rgba(255,60,60,0.07);
        z-index: 2147483646; pointer-events: none;
        left: ${e.clientX}px; top: ${e.clientY}px;
        width: 0; height: 0;
      `);
      document.body.appendChild(selRectEl);

      hintEl.textContent = '② 終点をクリック（スクロールして画面外もOK）　[ESC でキャンセル]';

    } else if (state === 'waiting_second') {
      const point2 = { docX, docY };
      state = 'capturing';

      const rect = {
        x:      Math.round(Math.min(point1.docX, point2.docX)),
        y:      Math.round(Math.min(point1.docY, point2.docY)),
        width:  Math.round(Math.abs(point2.docX - point1.docX)),
        height: Math.round(Math.abs(point2.docY - point1.docY))
      };

      cleanupUI();

      if (rect.width < 2 || rect.height < 2) {
        showToast('⚠️ 範囲が小さすぎます。もう一度試してください。');
        state = 'idle';
        return;
      }

      showProcessing();
      chrome.runtime.sendMessage({ action: 'doCapture', rect, format });
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      cleanupUI();
      state = 'idle';
    }
  }

  // ─── UI クリーンアップ ───────────────────────────
  function cleanupUI() {
    [overlayEl, hintEl, marker1El, selRectEl, coordEl].forEach(el => el && el.remove());
    overlayEl = hintEl = marker1El = selRectEl = coordEl = null;
    point1 = null;
    document.removeEventListener('keydown', onKeydown, true);
  }

  // ─── 処理中オーバーレイ ──────────────────────────
  function showProcessing() {
    processingEl = makeEl('div', `
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.4);
      z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
    `);
    const box = makeEl('div', `
      background: #fff; border-radius: 12px;
      padding: 22px 36px; text-align: center;
      font: 600 14px/1.8 -apple-system,sans-serif; color: #333;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    `);
    box.innerHTML = '📸 キャプチャ中...<br><span style="font-weight:400;font-size:12px;color:#888">ページを自動スクロールしています</span>';
    processingEl.appendChild(box);
    document.body.appendChild(processingEl);
  }

  function hideProcessing() {
    if (processingEl) { processingEl.remove(); processingEl = null; }
    state = 'idle';
  }

  // ─── トースト通知 ────────────────────────────────
  function showToast(msg) {
    const t = makeEl('div', `
      position: fixed; bottom: 28px; left: 50%;
      transform: translateX(-50%);
      background: rgba(20,20,20,0.9); color: #fff;
      padding: 12px 24px; border-radius: 8px;
      font: 13px -apple-system,sans-serif;
      z-index: 2147483647; white-space: nowrap;
      box-shadow: 0 2px 14px rgba(0,0,0,0.45);
    `);
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ─── ヘルパー ────────────────────────────────────
  function makeEl(tag, cssText) {
    const el = document.createElement(tag);
    el.style.cssText = cssText;
    return el;
  }
}
