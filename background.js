'use strict';

// ─── メッセージ受信 ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'doCapture') {
    const tabId    = sender.tab.id;
    const windowId = sender.tab.windowId;

    captureRegion(tabId, windowId, msg.rect, msg.format)
      .then(dataUrl => {
        const ext = msg.format === 'jpeg' ? 'jpg' : 'png';
        chrome.downloads.download({
          url: dataUrl,
          filename: `screenshot_${formatDate()}.${ext}`,
          saveAs: false
        });
        chrome.tabs.sendMessage(tabId, { action: 'captureComplete' });
      })
      .catch(err => {
        console.error('[RegionSS v5] error:', err);
        chrome.tabs.sendMessage(tabId, { action: 'captureError', error: err.message });
      });

    return true;
  }
});

// ─── メイン ──────────────────────────────────────────────────────────────────
async function captureRegion(tabId, windowId, rect, format) {
  // ── ページ情報取得 ──────────────────────────────────────────────────────────
  const [{ result: info }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollX:       window.scrollX,
      scrollY:       window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight:window.innerHeight,
      dpr:           window.devicePixelRatio || 1,
      docWidth:      Math.max(document.body.scrollWidth,  document.documentElement.scrollWidth),
      docHeight:     Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    })
  });

  const { scrollX: origSX, scrollY: origSY,
          viewportWidth: vw, viewportHeight: vh,
          dpr, docWidth, docHeight } = info;

  // 範囲クランプ
  const rx = Math.max(0, Math.round(rect.x));
  const ry = Math.max(0, Math.round(rect.y));
  const rw = Math.min(Math.round(rect.width),  docWidth  - rx);
  const rh = Math.min(Math.round(rect.height), docHeight - ry);
  if (rw <= 0 || rh <= 0) throw new Error('範囲が無効です');

  // ── fixed/sticky 非表示 + スムーススクロール無効 ────────────────────────────
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      window.__rssOrigScroll = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      const hidden = [];
      document.querySelectorAll('*').forEach(el => {
        const pos = window.getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          hidden.push({ el, vis: el.style.visibility, pri: el.style.getPropertyPriority('visibility') });
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      });
      window.__rssHidden = hidden;
    }
  });

  // ── テストキャプチャで実際の画像サイズを取得 ─────────────────────────────────
  await scrollTo(tabId, rx, ry);
  await sleep(620);
  const testUrl    = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const testBitmap = await createImageBitmap(await (await fetch(testUrl)).blob());
  const imgW = testBitmap.width;   // 実際の物理px幅
  const imgH = testBitmap.height;  // 実際の物理px高さ
  testBitmap.close();

  // CSS px 換算の実際のビューポートサイズ（DPR端数問題を回避）
  const realVW = imgW / dpr;
  const realVH = imgH / dpr;

  // ── Canvas 初期化（物理px） ─────────────────────────────────────────────────
  const MAX_PX  = 16384;
  const canvasW = Math.min(Math.round(rw * dpr), MAX_PX);
  const canvasH = Math.min(Math.round(rh * dpr), MAX_PX);
  const canvas  = new OffscreenCanvas(canvasW, canvasH);
  const ctx     = canvas.getContext('2d');

  // ── スクロールステップ（20px オーバーラップで継ぎ目保険）─────────────────────
  // step < realVH にすることで隣接セクションが必ず重なる
  const OVERLAP = 20; // CSS px
  const stepsY  = buildSteps(ry, rh, realVH, OVERLAP, docHeight);
  const stepsX  = buildSteps(rx, rw, realVW, OVERLAP, docWidth);

  // 物理px でのキャンバス領域左上
  const pxRgnLeft = Math.round(rx * dpr);
  const pxRgnTop  = Math.round(ry * dpr);

  for (const sy of stepsY) {
    for (const sx of stepsX) {
      await scrollTo(tabId, sx, sy);
      await sleep(620);

      // 実スクロール位置取得
      const [{ result: actual }] = await chrome.scripting.executeScript({
        target: { tabId },
        func:   () => ({ scrollX: window.scrollX, scrollY: window.scrollY })
      });

      // キャプチャ & デコード
      const dataUrl   = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const imgBitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());

      // ──────────────────────────────────────────────────────────────────────
      // 【正しいマッピング計算】
      //
      // 画像row r  → ドキュメント物理px: pxCapTop + r
      // Canvas row c → ドキュメント物理px: pxRgnTop + c
      // よって: c = pxCapTop + r - pxRgnTop  ← これが唯一の正しい式
      //
      // bleed: 重複領域を広げるために srcY を pxIntTop より手前に取る。
      //        ただし srcY >= 0 の制約があるため、
      //        dstY は必ず pxCapTop + srcY - pxRgnTop で算出する（ずらしNG）
      // ──────────────────────────────────────────────────────────────────────
      const pxCapLeft   = Math.round(actual.scrollX * dpr);
      const pxCapTop    = Math.round(actual.scrollY * dpr);
      const pxCapRight  = pxCapLeft + imgBitmap.width;
      const pxCapBottom = pxCapTop  + imgBitmap.height;

      // 目的範囲との交差（物理px）
      const pxIntLeft   = Math.max(pxRgnLeft,          pxCapLeft);
      const pxIntTop    = Math.max(pxRgnTop,            pxCapTop);
      const pxIntRight  = Math.min(pxRgnLeft + canvasW, pxCapRight);
      const pxIntBottom = Math.min(pxRgnTop  + canvasH, pxCapBottom);

      if (pxIntRight <= pxIntLeft || pxIntBottom <= pxIntTop) {
        imgBitmap.close();
        continue;
      }

      // ブリード付き source 座標（可能な限り前から取る）
      const BLEED = 8;
      const srcX = Math.max(0, pxIntLeft - pxCapLeft - BLEED);
      const srcY = Math.max(0, pxIntTop  - pxCapTop  - BLEED);
      const srcW = Math.min(imgBitmap.width  - srcX, pxIntRight  - pxCapLeft - srcX + BLEED);
      const srcH = Math.min(imgBitmap.height - srcY, pxIntBottom - pxCapTop  - srcY + BLEED);

      // ★ dstX/Y: 画像の物理的な対応位置から計算（コンテンツをずらさない）
      const dstX = pxCapLeft + srcX - pxRgnLeft;
      const dstY = pxCapTop  + srcY - pxRgnTop;

      if (srcW > 0 && srcH > 0) {
        ctx.drawImage(imgBitmap, srcX, srcY, srcW, srcH, dstX, dstY, srcW, srcH);
      }
      imgBitmap.close();
    }
  }

  // 元のスクロール位置に戻す & 要素復元
  await scrollTo(tabId, origSX, origSY);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.documentElement.style.scrollBehavior = window.__rssOrigScroll || '';
      if (!window.__rssHidden) return;
      window.__rssHidden.forEach(({ el, vis, pri }) => {
        if (pri) el.style.setProperty('visibility', vis || '', pri);
        else      el.style.visibility = vis || '';
      });
      window.__rssHidden = null;
    }
  });

  // 最終出力
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const quality  = format === 'jpeg' ? 0.97 : undefined;
  const outBlob  = await canvas.convertToBlob({ type: mimeType, quality });

  const ab     = await outBlob.arrayBuffer();
  const bytes  = new Uint8Array(ab);
  let binary   = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

// ─── ヘルパー ─────────────────────────────────────────────────────────────────
async function scrollTo(tabId, x, y) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func:   (x, y) => window.scrollTo(x, y),
    args:   [x, y]
  });
}

/**
 * [start, start+size) を (viewportSize - overlap) 刻みで分割。
 * 隣接セクションが必ず overlap px 重なるため継ぎ目がゼロになる。
 */
function buildSteps(start, size, viewportSize, overlap, docSize) {
  const step = Math.max(1, viewportSize - overlap);
  const steps = [];
  const seen  = new Set();
  for (let pos = start; pos < start + size; pos += step) {
    const clamped = Math.min(pos, Math.max(0, docSize - viewportSize));
    if (!seen.has(clamped)) { seen.add(clamped); steps.push(clamped); }
  }
  return steps;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
