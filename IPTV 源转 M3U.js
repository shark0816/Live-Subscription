// Cloudflare Workers：IPTV 文本源转 M3U 订阅工具（增强修复版）
// 绑定变量：UUID（必填）、SUB_PASSWORD（可选，默认 subs）、IPTV_KV（KV 命名空间）
//
// 变更说明：
//  - 修复持久订阅链接 /subs 串号问题（支持 ?uuid= 参数，按用户返回自己的列表）
//  - 解析 #genre# 分组行，保留源站自带分组
//  - 频道名/分组名转义，避免 " 与 , 破坏 M3U 属性
//  - 源链接抓取增加超时（AbortController）
//  - M3U 输出增加 CORS 头
//  - 认证页 uuid 输入框转义（防 XSS）
//  - 首页大文本不再整段回填 textarea（避免数 MB 页面）
//  - 历史列表展示上限，清空仍删干净

const FETCH_TIMEOUT = 12000; // 源链接抓取超时（毫秒）

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const correctUuid = env.UUID;
    const subPassword = env.SUB_PASSWORD || 'subs';

    if (!correctUuid) {
      return new Response('错误：请在 Worker Settings → Variables 中设置 UUID 变量', { status: 500 });
    }

    const providedUuid = url.searchParams.get('uuid') || '';
    const isAuthenticated = providedUuid === correctUuid;

    const isSubPath = path === '/' + subPassword || path === '/' + subPassword + '/';
    const isStandardSub = path === '/sub';

    // ===== 公开订阅输出（无需 UUID；可带 ?uuid= 指定返回哪个用户的列表） =====
    if (isSubPath) {
      const subUuid = url.searchParams.get('uuid') || correctUuid;
      const m3u = await env.IPTV_KV.get('m3u_' + subUuid);
      if (!m3u) return new Response('尚未转换过任何订阅', { status: 404 });
      return new Response(m3u, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Content-Disposition': 'inline; filename="iptv.m3u"',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ===== 兼容旧链接 /sub?uuid= =====
    if (isStandardSub) {
      if (!isAuthenticated) return new Response('订阅链接无效', { status: 403 });
      const m3u = await env.IPTV_KV.get('m3u_' + providedUuid);
      if (!m3u) return new Response('尚未转换过任何订阅', { status: 404 });
      return new Response(m3u, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Content-Disposition': 'inline; filename="iptv.m3u"',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ===== 未认证 → 验证页 =====
    if (!isAuthenticated) {
      return new Response(getAuthPage(providedUuid), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // ===== 管理首页 =====
    if (path === '/' || path === '') {
      if (request.method === 'GET') {
        const lastSourceUrl = await env.IPTV_KV.get('last_source_url_' + providedUuid) || '';
        const lastContent = await env.IPTV_KV.get('last_content_' + providedUuid) || '';
        const historyList = await getHistoryList(env, providedUuid);
        return new Response(getMainPage(lastSourceUrl, lastContent, historyList, providedUuid, subPassword), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      if (request.method === 'POST') {
        try {
          const formData = await request.formData();
          let content = formData.get('content') || '';
          const sourceUrl = formData.get('source_url') || '';
          const uploadedFile = formData.get('file');
          const saveHistory = formData.get('save_history') === 'on';

          if (uploadedFile && uploadedFile.size > 0) {
            if (uploadedFile.size > 4 * 1024 * 1024) {
              return new Response('文件太大（超过 4MB）', { status: 400 });
            }
            try {
              content = await uploadedFile.text();
              content = content.replace(/\r\n?/g, '\n').replace(/\n\s*\n+/g, '\n').trim();
            } catch (e) {
              return new Response('文件读取失败: ' + e.message, { status: 400 });
            }
          }

          if (!content.trim() && !sourceUrl.trim()) {
            return new Response('请至少提供一种输入方式', { status: 400 });
          }

          // 仅填写链接、无文本时，尝试抓取（失败不再静默吞掉）
          if (sourceUrl.trim() && !content.trim()) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
            try {
              const resp = await fetch(sourceUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                },
                redirect: 'follow',
                signal: ctrl.signal
              });

              if (!resp.ok) throw new Error('HTTP ' + resp.status);

              let fetchedText = await resp.text();
              const preMatch = fetchedText.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
              if (preMatch && preMatch[1]) {
                fetchedText = preMatch[1];
              } else {
                fetchedText = fetchedText.replace(/<[^>]+>/g, '\n');
              }

              fetchedText = fetchedText.replace(/\r\n?/g, '\n').replace(/\n\s*\n+/g, '\n').replace(/^\n+|\n+$/g, '').trim();

              if (fetchedText.length <= 20) throw new Error('抓取内容过短或无有效数据');
              content = fetchedText;
            } catch (e) {
              return new Response('订阅源链接抓取失败: ' + e.message, { status: 400 });
            } finally {
              clearTimeout(timer);
            }
          }

          const m3u = convertToM3U(content);
          await env.IPTV_KV.put('m3u_' + providedUuid, m3u);
          await env.IPTV_KV.put('last_source_url_' + providedUuid, sourceUrl);
          await env.IPTV_KV.put('last_content_' + providedUuid, content);

          if (saveHistory && content.trim()) {
            await saveHistoryRecord(env, providedUuid, content, sourceUrl);
          }

          const stats = getStats(m3u);
          const persistentSubUrl = url.origin + '/' + subPassword + '?uuid=' + encodeURIComponent(providedUuid);
          const legacySubUrl = url.origin + '/sub?uuid=' + encodeURIComponent(providedUuid);

          return new Response(getResultPage(m3u, persistentSubUrl, legacySubUrl, providedUuid, stats), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });

        } catch (err) {
          console.error('POST 处理异常:', err);
          return new Response('转换失败: ' + err.message, {
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      }
    }

    // ===== 历史记录列表 =====
    if (path === '/history') {
      const historyList = await getHistoryList(env, providedUuid);
      return new Response(getHistoryPage(historyList, providedUuid), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // ===== 删除单条历史 =====
    if (path === '/delete-history') {
      const id = url.searchParams.get('id');
      if (id) {
        await env.IPTV_KV.delete('history_' + providedUuid + '_' + id);
      }
      return Response.redirect(url.origin + '/history?uuid=' + encodeURIComponent(providedUuid), 302);
    }

    // ===== 清空全部历史（复用已分页列表，确保删干净） =====
    if (path === '/clear-history') {
      const list = await getHistoryList(env, providedUuid);
      await Promise.all(list.map(function (item) {
        return env.IPTV_KV.delete('history_' + providedUuid + '_' + item.id);
      }));
      return Response.redirect(url.origin + '/history?uuid=' + encodeURIComponent(providedUuid), 302);
    }

    return new Response('404 Not Found', { status: 404 });
  }
};

// ===== 历史列表（带 KV 分页，超过 1000 条也能取全） =====
async function getHistoryList(env, uuid) {
  const list = [];
  const prefix = 'history_' + uuid + '_';
  let cursor;
  do {
    const res = await env.IPTV_KV.list({ prefix: prefix, cursor: cursor });
    for (const key of res.keys) {
      const value = await env.IPTV_KV.get(key.name);
      if (value) {
        try {
          const data = JSON.parse(value);
          const id = key.name.replace(prefix, '');
          list.push({ id: id, ...data });
        } catch (e) {}
      }
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);

  return list.sort(function (a, b) {
    return b.timestamp - a.timestamp;
  });
}

async function saveHistoryRecord(env, uuid, content, sourceUrl) {
  const timestamp = Date.now();
  const id = String(timestamp);
  const record = {
    content: content.slice(0, 500),
    sourceUrl: sourceUrl,
    timestamp: timestamp,
    date: new Date(timestamp).toLocaleString('zh-CN')
  };
  await env.IPTV_KV.put('history_' + uuid + '_' + id, JSON.stringify(record));
}

function getStats(m3u) {
  const lines = m3u.split('\n');
  let channelCount = 0;

  for (var i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXTINF')) {
      channelCount++;
    }
  }

  return {
    channelCount: channelCount,
    totalLines: lines.length
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 频道名 / 分组名清洗：去掉引号、把英文逗号转全角，避免破坏 M3U 属性或显示名解析
function sanitizeName(s) {
  return String(s || '')
    .replace(/["']/g, '')
    .replace(/,/g, '，')
    .trim() || '未知频道';
}

// ===== 按省份/地区归类（兜底用，当源未提供 #genre# 分组时） =====
function classifyGroup(name) {
  var provinceGroups = {
    '央视': ['CCTV', '中央', 'CGTN'],
    '江苏': ['江苏', '南京', '苏', '扬州', '无锡', '苏州', '常州', '徐州', '南通', '淮安', '盐城', '镇江', '泰州', '宿迁'],
    '浙江': ['浙江', '杭州', '宁波', '温州', '绍兴', '嘉兴', '湖州', '舟山', '金华', '台州', '丽水', '衢州'],
    '广东': ['广东', '广州', '深圳', '佛山', '东莞', '中山', '珠海', '江门', '惠州', '汕头'],
    '山东': ['山东', '济南', '青岛', '淄博', '枣庄', '烟台', '潍坊', '济宁', '泰安', '威海'],
    '河南': ['河南', '郑州', '洛阳', '开封', '安阳', '新乡', '焦作', '许昌', '南阳', '商丘'],
    '四川': ['四川', '成都', '绵阳', '德阳', '宜宾', '泸州', '南充', '乐山'],
    '湖北': ['湖北', '武汉', '襄阳', '宜昌', '荆州', '黄石', '十堰'],
    '湖南': ['湖南', '长沙', '株洲', '湘潭', '衡阳', '岳阳', '常德'],
    '河北': ['河北', '石家庄', '唐山', '邯郸', '保定', '沧州'],
    '安徽': ['安徽', '合肥', '芜湖', '蚌埠', '淮南', '马鞍山'],
    '辽宁': ['辽宁', '沈阳', '大连', '鞍山', '抚顺', '锦州'],
    '重庆': ['重庆'],
    '北京': ['北京'],
    '上海': ['上海'],
    '天津': ['天津']
  };
  var keys = Object.keys(provinceGroups);
  for (var j = 0; j < keys.length; j++) {
    var kws = provinceGroups[keys[j]];
    for (var k = 0; k < kws.length; k++) {
      if (name.indexOf(kws[k]) !== -1) return keys[j];
    }
  }
  return '未分类';
}

// ===== 文本源 → 标准 M3U =====
// 支持：原样 M3U、裸链接行、频道名+URL（任意分隔符）、以及 组名,#genre# 分组格式
function convertToM3U(input) {
  var raw = (input || '').trim();
  if (raw.startsWith('#EXTM3U')) return raw + '\n';   // 已是 M3U，原样返回

  var text = raw
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r\n?/g, '\n')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

  if (!text) return '#EXTM3U\n# 无有效内容\n';

  var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  var out = ['#EXTM3U', '# Generated from TXT/M3U input', '# 时间: ' + new Date().toLocaleString('zh-CN')];
  var currentGroup = '未分类';

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;

    // 分组行： 组名,#genre#  → 设置后续频道的分组
    var genre = line.match(/^(.*?)#genre#/i);
    if (genre) {
      var g = genre[1].replace(/[,，\s]+$/g, '').trim();
      if (g) currentGroup = g;
      continue;
    }

    // 1) 整行就是一个裸链接
    var bare = line.match(/^(https?|rtsp|rtp|mms):\/\/\S+$/i);
    if (bare) {
      out.push('#EXTINF:-1 tvg-logo="" group-title="' + sanitizeName(currentGroup) + '",未知频道');
      out.push(bare[0]);
      continue;
    }

    // 2) 行内含链接：提取第一个 URL，其余当名称（兼容 , ： $ 空格 等分隔符）
    var um = line.match(/(https?|rtsp|rtp|mms):\/\/\S+/i);
    if (um) {
      var url = um[0];
      var rawName = line.replace(url, '').replace(/[,，:：\s$#|]+/g, ' ').trim();
      var name = sanitizeName(rawName);
      var grp = (currentGroup && currentGroup !== '未分类')
        ? sanitizeName(currentGroup)
        : sanitizeName(classifyGroup(name));
      out.push('#EXTINF:-1 tvg-logo="" tvg-name="' + name + '" group-title="' + grp + '",' + name);
      out.push(url);
      continue;
    }
    // 其它无法识别的行跳过
  }

  if (out.length <= 3) out.push('# 无有效源，请检查输入内容');
  return out.join('\n') + '\n';
}

// ===== 页面：验证页 =====
function getAuthPage(providedUuid) {
  var safeUuid = escapeHtml(providedUuid || '');
  var errorMsg = providedUuid ? '<p class="error-msg">密钥错误，请重试</p>' : '';
  var inputClass = providedUuid ? 'error' : '';

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>访问验证</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; }
.auth-card { background: white; padding: 50px 40px; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 480px; width: 100%; text-align: center; }
.auth-card h2 { color: #333; font-size: 24px; margin-bottom: 8px; }
.auth-card .subtitle { color: #888; font-size: 14px; margin-bottom: 30px; }
.auth-card input { width: 100%; padding: 14px 16px; font-size: 15px; border: 2px solid #e0e0e0; border-radius: 12px; transition: border-color 0.3s; outline: none; font-family: monospace; }
.auth-card input:focus { border-color: #667eea; }
.auth-card input.error { border-color: #e74c3c; background: #fef0ef; }
.auth-card button { width: 100%; padding: 14px; margin-top: 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
.auth-card button:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4); }
.auth-card .error-msg { color: #e74c3c; font-size: 14px; margin-top: 12px; }
.auth-card .footer { margin-top: 24px; color: #aaa; font-size: 13px; }
.auth-icon { font-size: 48px; margin-bottom: 16px; }
</style>
</head>
<body>
<div class="auth-card">
<div class="auth-icon">🔐</div>
<h2>访问验证</h2>
<p class="subtitle">请输入管理员提供的访问密钥</p>
<form action="/" method="GET">
<input type="text" name="uuid" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${safeUuid}" class="${inputClass}">
<button type="submit">进入</button>
</form>
${errorMsg}
<div class="footer">IPTV 源转 M3U 订阅工具</div>
</div>
</body>
</html>`;
}

// ===== 页面：管理首页 =====
function getMainPage(lastSourceUrl, lastContent, historyList, currentUuid, subPassword) {
  var encodedUuid = encodeURIComponent(currentUuid || '');
  var sourceVal = escapeHtml(lastSourceUrl || '');
  // 大文本不整段回填，避免页面膨胀到数 MB
  var prefill = (lastContent && lastContent.length <= 50000) ? escapeHtml(lastContent) : '';
  var bigNote = (lastContent && lastContent.length > 50000)
    ? '<p class="hint">上次内容较大（' + lastContent.length + ' 字符），未自动回填，可重新粘贴或填写源链接后转换。</p>'
    : '';

  var historyCount = historyList.length;
  var previewItems = historyList.slice(0, 5).map(function (it) {
    return '<li>🕐 ' + escapeHtml(it.date || '') + ' · ' + escapeHtml((it.content || '').slice(0, 60)) + (it.sourceUrl ? ' · 🔗 ' + escapeHtml(it.sourceUrl) : '') + '</li>';
  }).join('');
  var historyHtml = previewItems
    ? '<div class="card"><div class="card-title">🕘 最近历史（共 ' + historyCount + ' 条）<a class="mini-link" href="/history?uuid=' + encodedUuid + '">查看全部</a></div><ul class="hist-list">' + previewItems + '</ul></div>'
    : '';

  var persistentUrl = '/' + subPassword + '?uuid=' + encodedUuid;

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IPTV 源转 M3U 订阅工具</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f4f8; color: #333; padding: 20px; min-height: 100vh; }
.container { max-width: 960px; margin: 0 auto; }
.header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 35px; border-radius: 16px; margin-bottom: 28px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
.header h1 { font-size: 22px; font-weight: 700; }
.header h1 span { font-size: 14px; font-weight: 400; opacity: 0.85; display: block; margin-top: 4px; }
.header-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.header-actions a { color: white; background: rgba(255,255,255,0.2); padding: 8px 18px; border-radius: 8px; text-decoration: none; font-size: 14px; transition: background 0.2s; }
.header-actions a:hover { background: rgba(255,255,255,0.3); }
.card { background: white; border-radius: 16px; padding: 28px 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); margin-bottom: 24px; }
.card-title { font-size: 16px; font-weight: 600; color: #555; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-title .mini-link { font-size: 13px; color: #667eea; text-decoration: none; font-weight: 500; }
label { display: block; font-weight: 500; font-size: 14px; color: #555; margin-bottom: 6px; }
input[type="text"], textarea { width: 100%; padding: 12px 14px; font-size: 14px; border: 2px solid #e8ecf1; border-radius: 10px; transition: border-color 0.3s, box-shadow 0.3s; outline: none; font-family: inherit; background: #fafbfc; }
input[type="text"]:focus, textarea:focus { border-color: #667eea; box-shadow: 0 0 0 3px rgba(102,126,234,0.12); }
textarea { min-height: 200px; resize: vertical; font-family: "Consolas", monospace; font-size: 13px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.file-wrap { flex: 1; }
.check { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #555; margin-top: 14px; }
.hint { color: #b8860b; font-size: 13px; margin-top: 8px; }
.btn { padding: 12px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px; transition: transform 0.2s; display: inline-block; cursor: pointer; border: none; }
.btn:hover { transform: translateY(-2px); }
.btn-primary { background: #667eea; color: white; }
.btn-ghost { background: #eef1f5; color: #555; }
.sub-box { background: #f8f9fc; border-radius: 10px; padding: 14px 16px; word-break: break-all; font-family: "Consolas", monospace; font-size: 13px; border: 1px solid #eef1f5; margin-top: 8px; }
.formats { font-size: 13px; color: #888; line-height: 1.7; margin-top: 10px; }
.formats code { background: #eef1f5; padding: 1px 6px; border-radius: 6px; font-size: 12px; }
.hist-list { list-style: none; }
.hist-list li { font-size: 13px; color: #666; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
.hist-list li:last-child { border-bottom: none; }
</style>
</head>
<body>
<div class="container">
<div class="header">
<h1>IPTV 源转 M3U 订阅工具<span>粘贴文本 / 上传文件 / 填源链接，一键生成可订阅 M3U</span></h1>
<div class="header-actions">
<a href="/history?uuid=${encodedUuid}">📜 历史记录</a>
</div>
</div>

<div class="card">
<div class="card-title">⚙️ 转换输入</div>
<form action="/?uuid=${encodedUuid}" method="POST" enctype="multipart/form-data">
<label for="source_url">源链接（可选，留空则使用下方文本）</label>
<input type="text" id="source_url" name="source_url" placeholder="https://example.com/iptv.txt" value="${sourceVal}">
<label for="content" style="margin-top:14px;">频道文本（支持 频道名,URL / 裸链接 / 组名,#genre# 格式）</label>
<textarea id="content" name="content" placeholder="CCTV-1,http://1.2.3.4/live/1&#10;http://1.2.3.4/live/2&#10;央视,#genre#&#10;CCTV-13,http://1.2.3.4/live/13">${prefill}</textarea>
${bigNote}
<div class="row" style="margin-top:14px;">
<div class="file-wrap">
<label for="file">上传文件（.txt / .m3u，≤4MB）</label>
<input type="file" id="file" name="file" accept=".txt,.m3u,.m3u8,text/plain">
</div>
</div>
<div class="check">
<label style="margin:0;"><input type="checkbox" name="save_history" value="on"> 保存本次内容到历史记录</label>
</div>
<button type="submit" class="btn btn-primary" style="margin-top:18px;width:100%;">🚀 开始转换</button>
</form>
<div class="formats">
支持格式示例：<br>
<code>频道名,http://host/play/1</code> ｜ <code>组名,#genre#</code> 后跟该组频道 ｜ 整行裸 <code>http://...</code> 链接 ｜ 已标准的 <code>#EXTM3U</code> 内容（原样返回）
</div>
</div>

<div class="card">
<div class="card-title">🔗 我的持久订阅链接</div>
<div class="sub-box">${escapeHtml(persistentUrl)}</div>
<p class="hint">把上面这个链接（含 ?uuid=）填进 IPTV 播放器即可，转换后自动更新。</p>
</div>

${historyHtml}
</div>
</body>
</html>`;
}

// ===== 页面：转换结果 =====
function getResultPage(m3uContent, persistentSubUrl, legacySubUrl, currentUuid, stats) {
  var homeUrl = '/?uuid=' + encodeURIComponent(currentUuid);
  var historyUrl = '/history?uuid=' + encodeURIComponent(currentUuid);
  var preview = m3uContent.split('\n').slice(0, 30).map(function (l) { return escapeHtml(l); }).join('\n');
  var pu = escapeHtml(persistentSubUrl);
  var lu = escapeHtml(legacySubUrl);

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>转换成功 - IPTV 工具</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f4f8; color: #333; padding: 20px; min-height: 100vh; }
.container { max-width: 960px; margin: 0 auto; }
.card { background: white; border-radius: 16px; padding: 28px 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); margin-bottom: 24px; }
.success-header { background: linear-gradient(135deg, #00b894 0%, #00a86b 100%); color: white; padding: 30px 35px; border-radius: 16px; margin-bottom: 28px; text-align: center; }
.success-header h1 { font-size: 28px; }
.success-header .sub { font-size: 15px; opacity: 0.9; margin-top: 6px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 16px; margin: 16px 0; }
.stat-item { background: #f8f9fc; border-radius: 10px; padding: 14px; text-align: center; }
.stat-item .num { font-size: 28px; font-weight: 700; color: #667eea; }
.stat-item .label { font-size: 13px; color: #888; margin-top: 2px; }
.sub-url-box { background: #f8f9fc; border-radius: 10px; padding: 14px 16px; word-break: break-all; font-family: "Consolas", monospace; font-size: 13px; border: 1px solid #eef1f5; margin-top: 8px; }
.sub-url-box .label { font-size: 12px; color: #888; font-weight: 500; display: block; margin-bottom: 4px; }
.btn-group { display: flex; gap: 12px; flex-wrap: wrap; margin: 20px 0 8px; }
.btn { padding: 10px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px; transition: transform 0.2s; display: inline-block; cursor: pointer; border: none; }
.btn:hover { transform: translateY(-2px); }
.btn-primary { background: #667eea; color: white; }
.btn-success { background: #00b894; color: white; }
.btn-ghost { background: #eef1f5; color: #555; }
.preview { background: #1e1e2e; color: #d4d4d4; border-radius: 10px; padding: 16px; font-family: "Consolas", monospace; font-size: 12px; overflow-x: auto; white-space: pre; max-height: 320px; overflow-y: auto; }
.copy-btn { margin-top: 8px; }
</style>
</head>
<body>
<div class="container">
<div class="success-header">
<h1>✅ 转换成功</h1>
<div class="sub">已生成标准 M3U，复制下方链接到播放器即可订阅</div>
</div>

<div class="card">
<div class="card-title">📊 转换统计</div>
<div class="stat-grid">
<div class="stat-item"><div class="num">${stats.channelCount}</div><div class="label">频道数量</div></div>
<div class="stat-item"><div class="num">${stats.totalLines}</div><div class="label">总行数</div></div>
</div>
</div>

<div class="card">
<div class="card-title">🔗 订阅链接</div>
<div class="sub-url-box"><span class="label">持久订阅链接（推荐，转换后自动更新）</span><code id="purl">${pu}</code></div>
<button class="btn btn-primary copy-btn" onclick="copyText(this,'purl')">复制持久链接</button>

<div class="sub-url-box" style="margin-top:16px;"><span class="label">兼容旧链接 /sub?uuid=</span><code id="lurl">${lu}</code></div>
<button class="btn btn-ghost copy-btn" onclick="copyText(this,'lurl')">复制旧链接</button>
</div>

<div class="card">
<div class="card-title">👀 M3U 预览（前 30 行）</div>
<pre class="preview">${preview}</pre>
</div>

<div class="btn-group">
<a class="btn btn-primary" href="${homeUrl}">← 返回首页</a>
<a class="btn btn-ghost" href="${historyUrl}">📜 历史记录</a>
</div>
</div>

<script>
function copyText(btn, id) {
  var el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(function () {
    var t = btn.textContent; btn.textContent = '已复制 ✓';
    setTimeout(function () { btn.textContent = t; }, 1500);
  }).catch(function () { btn.textContent = '复制失败'; });
}
</script>
</body>
</html>`;
}

// ===== 页面：历史记录 =====
function getHistoryPage(historyList, currentUuid) {
  var encodedUuid = encodeURIComponent(currentUuid || '');
  var homeUrl = '/?uuid=' + encodedUuid;
  var total = historyList.length;
  var display = historyList.slice(0, 500); // 展示上限，避免页面过重在
  var itemsHtml = '';

  if (display.length === 0) {
    itemsHtml = '<div class="empty-msg">📭 暂无历史记录<br><span style="font-size:14px;color:#ccc;">转换时勾选"保存本次内容到历史记录"即可保存</span></div>';
  } else {
    for (var i = 0; i < display.length; i++) {
      var item = display[i];
      var dateStr = item.date || '未知时间';
      var contentStr = escapeHtml(item.content || '');
      var sourceStr = item.sourceUrl ? '<div class="source-url">🔗 ' + escapeHtml(item.sourceUrl) + '</div>' : '';
      itemsHtml = itemsHtml + '<div class="history-item">\n<div class="date">🕐 ' + dateStr + '</div>\n<div class="content">' + contentStr + '</div>\n' + sourceStr + '\n<div class="actions"><a href="/delete-history?uuid=' + encodedUuid + '&id=' + encodeURIComponent(item.id) + '" onclick="return confirm(\'确定要删除这条记录吗？\')">🗑️ 删除</a></div>\n</div>';
    }
  }

  var moreNote = total > display.length ? '<p class="hint">仅显示最新 ' + display.length + ' 条（共 ' + total + ' 条），清空将删除全部。</p>' : '';

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>历史记录 - IPTV 工具</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f4f8; color: #333; padding: 20px; min-height: 100vh; }
.container { max-width: 960px; margin: 0 auto; }
.header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px 32px; border-radius: 16px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.header h1 { font-size: 22px; }
.header-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.header-actions a { color: white; background: rgba(255,255,255,0.2); padding: 8px 18px; border-radius: 8px; text-decoration: none; font-size: 14px; transition: background 0.2s; }
.header-actions a:hover { background: rgba(255,255,255,0.3); }
.card { background: white; border-radius: 16px; padding: 24px 28px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); margin-bottom: 16px; }
.history-item { border-bottom: 1px solid #f0f0f0; padding: 16px 0; }
.history-item:last-child { border-bottom: none; }
.history-item .date { font-size: 13px; color: #888; }
.history-item .content { font-family: "Consolas", monospace; font-size: 13px; background: #f8f9fc; padding: 10px 14px; border-radius: 8px; margin: 8px 0; white-space: pre-wrap; word-break: break-all; max-height: 80px; overflow: hidden; }
.history-item .source-url { font-size: 13px; color: #667eea; word-break: break-all; }
.history-item .actions { margin-top: 8px; }
.history-item .actions a { color: #e74c3c; text-decoration: none; font-size: 13px; font-weight: 500; }
.history-item .actions a:hover { text-decoration: underline; }
.empty-msg { text-align: center; color: #aaa; padding: 40px 0; font-size: 16px; }
.hint { color: #b8860b; font-size: 13px; margin-top: 10px; }
.btn { padding: 10px 24px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px; transition: transform 0.2s; display: inline-block; cursor: pointer; border: none; }
.btn:hover { transform: translateY(-2px); }
.btn-danger { background: #e74c3c; color: white; }
</style>
</head>
<body>
<div class="container">
<div class="header">
<h1>📜 历史记录</h1>
<div class="header-actions">
<a href="${homeUrl}">← 返回首页</a>
<a href="/clear-history?uuid=${encodedUuid}" onclick="return confirm('确定清空全部历史记录？此操作不可恢复')">🗑️ 清空全部</a>
</div>
</div>
<div class="card">
${itemsHtml}
${moreNote}
</div>
</div>
</body>
</html>`;
}
