function render(c) {
  var dot = document.getElementById('dot');
  var status = document.getElementById('status');
  if (!c) {
    dot.className = 'dot bad';
    status.textContent = '未连接到 TA 平台';
  } else if (c.online) {
    dot.className = 'dot ok';
    status.textContent = '已连接 TA 平台';
  } else {
    dot.className = 'dot bad';
    status.textContent = '平台未运行（使用上次缓存）';
  }
  document.getElementById('jdName').textContent = (c && c.jd && (c.jd.name || c.jd.title)) || '—';
  document.getElementById('th').textContent = c && c.thresholds
    ? c.thresholds.high + ' / ' + c.thresholds.low : '—';
  document.getElementById('ts').textContent = c && c.fetchedAt
    ? new Date(c.fetchedAt).toLocaleString('zh-CN') : '—';
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'ta-get-jd' }, function (c) {
    if (chrome.runtime.lastError) { render(null); return; }
    render(c);
  });
}

document.getElementById('sync').addEventListener('click', function () {
  chrome.runtime.sendMessage({ type: 'ta-sync-now' }, function () { setTimeout(refresh, 200); });
});

// 采样按钮
var sampleBtn = document.getElementById('sample');
var sampleStatus = document.getElementById('sampleStatus');
sampleBtn.addEventListener('click', function () {
  sampleBtn.disabled = true;
  sampleStatus.className = '';
  sampleStatus.textContent = '采样中…';
  chrome.runtime.sendMessage({ type: 'ta-start-sample' }, function (resp) {
    sampleBtn.disabled = false;
    if (chrome.runtime.lastError) {
      sampleStatus.className = 'bad';
      sampleStatus.textContent = '失败：' + chrome.runtime.lastError.message;
      return;
    }
    if (!resp) {
      sampleStatus.className = 'bad';
      sampleStatus.textContent = '失败：后台无响应';
      return;
    }
    if (resp.ok) {
      sampleStatus.className = 'ok';
      var msg = '已上传（' + (resp.sizeKb || 0) + 'KB）';
      if (resp.truncated) msg += '（结构过大已截断）';
      if (resp.saved && resp.saved.file) msg += ' → ' + resp.saved.file;
      sampleStatus.textContent = msg;
    } else {
      sampleStatus.className = 'bad';
      sampleStatus.textContent = '失败：' + (resp.error || '未知错误');
    }
  });
});

refresh();
