'use strict';

let selectedFormat = 'png';

// フォルダ設定を復元
const folderInput = document.getElementById('folderInput');
try {
  chrome.storage.local.get('saveFolder', ({ saveFolder }) => {
    if (saveFolder !== undefined) folderInput.value = saveFolder;
  });
  folderInput.addEventListener('change', () => {
    chrome.storage.local.set({ saveFolder: folderInput.value.trim() });
  });
} catch (e) { /* storage未対応環境でも動作継続 */ }

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

  // フォルダ名を保存してから送信
  const folder = folderInput.value.trim() || 'Screenshots';
  try { chrome.storage.local.set({ saveFolder: folder }); } catch (e) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    await chrome.tabs.sendMessage(tab.id, {
      action: 'startCapture',
      format: selectedFormat,
      folder
    });

    document.getElementById('status').textContent = 'ページ上でクリックしてください';
    setTimeout(() => window.close(), 600);
  } catch (err) {
    document.getElementById('status').textContent = '❌ エラー: ' + err.message;
  }
});
