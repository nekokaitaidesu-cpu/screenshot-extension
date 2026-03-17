'use strict';

let selectedFormat = 'png';

document.querySelectorAll('.format-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedFormat = btn.dataset.format;
  });
});

document.getElementById('startBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    document.getElementById('status').textContent = '⚠️ このページでは使えません';
    return;
  }

  try {
    // content.js をページに注入（重複注入はスクリプト内でガード）
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    // 開始メッセージを送信
    await chrome.tabs.sendMessage(tab.id, {
      action: 'startCapture',
      format: selectedFormat
    });

    document.getElementById('status').textContent = 'ページ上でクリックしてください';
    setTimeout(() => window.close(), 600);
  } catch (err) {
    document.getElementById('status').textContent = '❌ エラー: ' + err.message;
  }
});
