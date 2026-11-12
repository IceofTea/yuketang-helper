var unsafeWindow = window;
var GM_xmlhttpRequest = function(){};
var GM_info = {script:{version:'test'}};
if (window.__yktCore) { 'already-injected'; } else { window.__yktCore = true;
// ==UserScript==
// @name         雨课堂学习助手 Pro
// @namespace    https://yuketang.cn/
// @version      4.1.0
// @description  雨课堂课程视频自动连播、批量刷课、进度可视化面板，可选作业代答与 AI 辅助
// @author       风之子 & community
// @license      GPL3
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @run-at       document-start
// @icon         http://yuketang.cn/favicon.ico
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      api.openai.com
// @connect      api.moonshot.cn
// @connect      api.deepseek.com
// @connect      dashscope.aliyuncs.com
// @connect      api.anthropic.com
// @connect      *
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js
// ==/UserScript==

(() => {
  'use strict';

  let panel; // UI 面板实例后置初始化

  // ---- 脚本配置，用户可修改 ----
  const Config = {
    version: '4.0.0', // 版本号
    playbackRate: 2,      // 视频播放倍速（基准值，实际会按 speedPool 随机）
    pptInterval: 3000,    // ppt翻页间隔
    // ---- 防检测 & 无人值守 ----
    autoStart: true,        // 打开课程列表页后自动开始（无需点按钮）
    autoStartDelaySec: 10,  // 自动开始倒计时秒数
    jitter: 0.4,            // 所有延时随机抖动 ±40%
    speedPool: [2], // 每集随机挑选的倍速（固定 2x，如需拟人可改回 [1.5, 2, 2.5]）
    restEveryLessons: 999,  // 每刷完 N 集休息一次（999≈不休息，调回 10 恢复防检测节奏）
    restMinSec: 180,        // 休息最短秒数
    restMaxSec: 420,        // 休息最长秒数
    lockedRetryMin: 30,     // 全部课时未解锁时，多少分钟后自动重试
    lockedMaxRetry: 72,     // 未解锁最多重试次数（30min*72=36小时）
    transientRetry: 3,      // 页面异常/登出等瞬态失败的重试次数
    storageKeys: {        // 使用者勿动
      progress: '[雨课堂脚本]刷课进度信息',
      ai: 'ykt_ai_conf',
      proClassCount: 'pro_lms_classCount',
      feature: 'ykt_feature_conf', // 是否开启AI作答/自动评论
      pendingAutoStart: 'ykt_pending_auto_start',
      batch: 'ykt_batch',
      reloadCount: 'ykt_reload',
      paused: 'ykt_paused',
      answerMode: 'ykt_answer_mode',
      speedPref: 'ykt_speed_pref',
      assist: 'ykt_assist'
    }
  };

  // ---- 本地题库（仅白名单课程，非白名单课程作业一律跳过不答） ----
  // 值：按题号顺序的答案数组；'T'=对 √，'F'=错 ×，其余为选项字母串（多选逐字母勾选）；null=题库缺失该题（留空）
  const QUESTION_BANK = {
    // 科研伦理与学术规范（章 -> 题号顺序答案；已按机主提供的答案图逐题核对补全）
    '26960231': {
      name: '科研伦理与学术规范',
      chapters: {
        '第一章': ['ABC', 'A', 'B', 'D', 'ABCD', 'ABC', 'D', 'A', 'BCD', 'C', 'D', 'D'],
        '第二章': ['ABCD', 'ABCD', 'ABCD', 'BCD', 'AD', 'A', 'ABCD', 'ACD', 'AC', 'A',
          'AC', 'D', 'A', 'BCD', 'ABD', 'ABCD', 'ABC', 'A', 'D'],
        '第三章': ['ABCD', 'ABCD', 'ABC', 'ABCD', 'ABD', 'ABCD', 'D', 'ABCD', 'BCD', 'B',
          'ABCD', 'ABCD', 'ABD', 'CD', 'D', 'ABCD', 'D', 'ABC', 'AD', 'ABCD'],
        '第四章': ['ABCD', 'ABC', 'ABCD', 'ABC', 'ABCD', 'ABD', 'ABCD', 'ABCD', 'ABCD', 'ABD',
          'ABCD', 'ABCD', 'ABCD', 'ABCD', 'ABD', 'ABCD', 'ACD', 'ACD', 'B', 'D'],
        '第五章': ['D', 'ABCD', 'ABCD', 'ABCD', 'ABD', 'ABCD', 'ABCD', 'D', 'ABCD', 'ABCD',
          'ABCD', 'D', 'ABCD', 'D', 'ABCD', 'ABCD', 'ABCD', 'D', 'ABCD', 'B'],
        '第六章': ['ABCD', 'D', 'AC', 'ABCD', 'AB', 'ACD', 'ABCD', 'ABCD', 'ABCD', 'ABD',
          'ABCD', 'ABCD', 'AB', 'ABCD', 'C', 'ABCD']
      }
    },
    // 生物医药实验室安全知识（部分 -> 题号顺序答案；第二部分原图实为 √√√CB）
    '26960232': {
      name: '生物医药实验室安全知识',
      chapters: {
        '第一部分': ['T', 'F', 'T', 'T', 'F'],
        '第二部分': ['T', 'T', 'T', 'C', 'B'],
        '第三部分': ['A', 'A', 'A', 'A', 'A'],
        '第四部分': ['A', 'B', 'D', 'B', 'D'],
        '第五部分': ['D', 'D', 'D', 'C', 'B'],
        '第六部分': ['D', 'D', 'A', 'D', 'C'],
        '第七部分': ['D', 'A', 'C', 'A', 'D'],
        '第八部分': ['B', 'C', 'C', 'A', 'B'],
        '第九部分': ['C', 'A', 'D', 'A', 'A']
      }
    }
  };

  // 应用倍速偏好到 Config：面板切换或脚本启动时调用；random=拟人池，数字=固定倍速
  function applySpeedPref() {
    const pref = Store.getSpeedPref();
    if (pref === 'random') {
      Config.speedPool = [1.5, 2, 2.5];
    } else {
      const n = parseFloat(pref);
      if (n > 0 && n <= 4) Config.speedPool = [n];
    }
    Config.playbackRate = Config.speedPool[0];
  }

  // leaf 标题解析章节（"作业 第一章课后习题" → "第一章"），返回对应答案序列
  const CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  function bankAnswersFor(bank, leafTitle) {
    const m = (leafTitle || '').match(/第([一二三四五六七八九十\d]+)\s*(章|部分|节|单元)/);
    if (m) {
      const n = CN_NUM[m[1]] || parseInt(m[1], 10);
      if (n) {
        const key = `第${'一二三四五六七八九十'[n - 1]}${m[2] === '节' || m[2] === '单元' ? '章' : m[2]}`;
        if (bank.chapters[key]) return { key, answers: bank.chapters[key] };
      }
      // 识别到了章节但题库没有这章：不乱猜，留空
      return null;
    }
    // 标题无章节信息（如"作业 习题"）：全部章节按序合并成单序列，按题号对齐
    const merged = [].concat(...Object.values(bank.chapters));
    return merged.length ? { key: '(整卷顺序)', answers: merged } : null;
  }

  const Utils = {
    // 短暂睡眠，等待网页加载
    sleep: (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms)),
    // 将一个 JSON 字符串解析为 JavaScript 对象
    safeJSONParse(value, fallback) {
      try {
        return JSON.parse(value);
      } catch (_) {
        return fallback;
      }
    },
    // 每隔一段时间检查某个条件是否满足（通过 checker 函数），如果满足就成功返回；如果超时仍未满足，就失败返回
    poll(checker, { interval = 1000, timeout = 20000 } = {}) {
      return new Promise(resolve => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (checker()) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (Date.now() - start > timeout) {
            clearInterval(timer);
            resolve(false);
          }
        }, interval);
      });
    },
    rand(min, max) { return min + Math.random() * (max - min); },
    // 带随机抖动的 sleep，模拟真人操作间隔
    jsleep(base) { return Utils.sleep(base * (1 + (Math.random() * 2 - 1) * Config.jitter)); },
    // 使用UI课程完成度来判别是否完成课程
    isProgressDone(text) {
      if (!text) return false;
      return text.includes('100%') || text.includes('99%') || text.includes('98%') || text.includes('已完成');
    },
    // 主要是规避firefox会创建多个iframe的问题
    inIframe() {
      return window.top !== window.self;
    },
    // 下滑到最底部，触发课程加载
    scrollToBottom(containerSelector) {
      const el = document.querySelector(containerSelector);
      if (el) el.scrollTop = el.scrollHeight;
    },
    getCurrentClassroomId() {
      const query = new URLSearchParams(location.search);
      const queryId = query.get('classroom_id');
      if (queryId) return queryId;

      const path = location.pathname;
      return path.match(/^\/ai-workspace\/lms-graph\/([^/]+)/)?.[1]
        || path.match(/^\/v2\/web\/studentLog\/([^/]+)/)?.[1]
        || path.match(/\/(\d+)\/studycontent$/)?.[1]
        || path.match(/\/pro\/lms\/[^/]+\/(\d+)/)?.[1]
        || '';
    },
    returnUrl() { // 得到课程开始的url
      if (location.pathname.includes('/v2/web/studentLog/') || location.pathname.includes('pro/lms/')) {
        return location.href
      }
      return ""
    },
    isSupportedLearningPage() {
      const path = location.pathname;
      return path.includes('/ai-workspace/lms-graph/')
        || path.includes('/v2/web/')
        || path.includes('/pro/lms/');
    },
    isCourseListPage() {
      const p = location.pathname;
      return /^\/pro\/(courselist|portal|index)?\/?$/.test(p) || p === '/pro' || p === '/pro/';
    },
    // 从课程列表页挑选一门未完成课程卡片，返回 {el, key}（本站卡片为 div 点击，无 href）
    cardKey(el) {
      return (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    },
    async pickUnfinishedCourse(panel) {
      // 等待卡片渲染（SPA 异步加载）
      await Utils.poll(() => document.querySelectorAll('.lesson-cardS, a[href*="/pro/lms"], a[href*="studycontent"]').length > 0, { interval: 500, timeout: 15000 });
      const batch = Store.getBatch() || {};
      const doneSet = new Set([...(batch.done || []), ...(batch.skipped || []), ...Store.claimedCardKeys()]);
      const cards = [...document.querySelectorAll('.lesson-cardS')];
      const pool = [];
      for (const card of cards) {
        const key = Utils.cardKey(card);
        if (!key) continue;
        const done = /100%|已完成|已结课/.test(key) && !/(\d{1,2})%/.test(key) || doneSet.has(key);
        panel && panel.log('课程卡：' + key.slice(0, 40) + ' => ' + (done ? '已完成/已跳过' : '未完成'));
        if (!done) pool.push({ el: card.querySelector('.el-card') || card, key });
      }
      // 多标签并发选课：随机挑一门，避免所有标签抢同一门课
      if (pool.length) return pool[Math.floor(Utils.rand(0, pool.length))];
      // 兜底：旧版链接式卡片
      const links = [...document.querySelectorAll('a[href]')];
      const candidates = links.filter(a => /\/pro\/lms|\/v2\/web|studycontent|\/pro\/\d/.test(a.getAttribute('href') || ''));
      const seen = new Set();
      for (const a of candidates) {
        const card = a.closest('a,li,dd,dt,div[class*=course],div[class*=item]') || a;
        const key = Utils.cardKey(card);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (!doneSet.has(key)) return { el: a, key, href: a.getAttribute('href') };
      }
      return null;
    },
    waitForMountTarget(timeout = 15000) {
      const getTarget = () => document.body || document.documentElement;
      const existing = getTarget();
      if (existing) return Promise.resolve(existing);

      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(getTarget());
        };
        const observer = new MutationObserver(() => {
          if (getTarget()) finish();
        });
        observer.observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', finish, { once: true });
        window.addEventListener('load', finish, { once: true });
        const timer = setTimeout(finish, timeout);
      });
    },
    async getDDL() {
      const element = document.querySelector('video') || document.querySelector('audio');

      const fallback = 180_000;
      if (!element) return fallback;

      let duration = Number(element.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        await new Promise(resolve => element.addEventListener('loadedmetadata', resolve, { once: true }));
        duration = Number(element.duration);
      }

      const elementDurationMs = duration * 1000;               // 转为秒
      const timeout = Math.max(elementDurationMs * 3, 10_000); // 至少 10 秒（防极短视频）;
      return timeout;
    },
    // 关闭雨课堂的挂机/离开检测弹窗，避免遮罩拦截刷课流程
    dismissPopups() {
      const wrappers = document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper');
      for (const wrapper of wrappers) {
        const style = getComputedStyle(wrapper);
        const rect = wrapper.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
        const text = wrapper.innerText || '';
        const buttons = [...wrapper.querySelectorAll('button')];
        const clickBtn = label => {
          const btn = buttons.find(b => (b.innerText || '').trim().includes(label));
          if (btn) btn.click();
        };
        if (text.includes('好好学习') || text.includes('继续观看')) {
          clickBtn('继续观看');
        } else if (text.includes('报告老师')) {
          clickBtn('取消');
        }
      }
    }
  };

  // ---- 存储工具 ----
  const Store = {
    getProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {}) || { url: { outside: 0, inside: 0 } };
      if (!all[url]) {
        all[url] = { outside: 0, inside: 0 };
        localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
      }
      return { all, current: all[url] };
    },
    setProgress(url, outside, inside = 0) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      all[url] = { outside, inside };
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    removeProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      delete all[url];
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    getAIConf() {
      const raw = localStorage.getItem(Config.storageKeys.ai);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        url: saved.url ?? "https://api.deepseek.com/chat/completions",
        key: saved.key ?? "sk-xxxxxxx",
        model: saved.model ?? "deepseek-chat",
        apiFormat: saved.apiFormat ?? "openai", // openai 或 anthropic
        authMethod: saved.authMethod ?? "bearer", // bearer 或 x-api-key
      };
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
      return conf;
    },
    setAIConf(conf) {
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
    },
    proCountKey() {
      const id = Utils.getCurrentClassroomId()
        || ((location.pathname.match(/pro\/lms\/([^/]+)/) || [])[1])
        || 'default';
      return Config.storageKeys.proClassCount + '_' + id;
    },
    getProClassCount() {
      const value = localStorage.getItem(Store.proCountKey());
      return value ? Number(value) : 1;
    },
    setProClassCount(count) {
      localStorage.setItem(Store.proCountKey(), count);
    },
    getBatch() {
      const raw = localStorage.getItem(Config.storageKeys.batch);
      const saved = Utils.safeJSONParse(raw, null);
      if (!saved || !saved.ts) return null;
      if (Date.now() - saved.ts > 48 * 60 * 60 * 1000) { localStorage.removeItem(Config.storageKeys.batch); return null; }
      return saved;
    },
    setBatch(courselistUrl, current = '') {
      const prev = Store.getBatch() || {};
      localStorage.setItem(Config.storageKeys.batch, JSON.stringify({
        courselistUrl,
        current: current || prev.current || '',
        done: prev.done || [],
        skipped: prev.skipped || [],
        map: prev.map || {},
        ts: Date.now()
      }));
    },
    addBatchList(listName, key) {
      const b = Store.getBatch();
      if (!b || !key) return;
      b[listName] = b[listName] || [];
      if (!b[listName].includes(key)) b[listName].push(key);
      b.ts = Date.now();
      localStorage.setItem(Config.storageKeys.batch, JSON.stringify(b));
    },
    clearBatch() { localStorage.removeItem(Config.storageKeys.batch); },
    setPaused() { sessionStorage.setItem(Config.storageKeys.paused, '1'); },
    clearPaused() { sessionStorage.removeItem(Config.storageKeys.paused); },
    isPaused() { return !!sessionStorage.getItem(Config.storageKeys.paused); },
    // 答题模式：默认关（纯刷课），面板按钮+确认后开启；只对题库白名单课程生效
    isAnswerMode() { return localStorage.getItem(Config.storageKeys.answerMode) === '1'; },
    setAnswerMode(on) { on ? localStorage.setItem(Config.storageKeys.answerMode, '1') : localStorage.removeItem(Config.storageKeys.answerMode); },
    // 答题助手（半自动）：只显示答案提示不代点；sessionStorage per-tab，关标签即失效
    isAssistMode() { return sessionStorage.getItem(Config.storageKeys.assist) === '1'; },
    setAssistMode(on) { on ? sessionStorage.setItem(Config.storageKeys.assist, '1') : sessionStorage.removeItem(Config.storageKeys.assist); },
    // 倍速偏好：'2'（默认）/ 'random' / '1' / '1.5' / '2.5' / '3'
    getSpeedPref() { return localStorage.getItem(Config.storageKeys.speedPref) || '2'; },
    setSpeedPref(v) { localStorage.setItem(Config.storageKeys.speedPref, String(v)); },
    getReloadCount() { return Number(sessionStorage.getItem(Config.storageKeys.reloadCount) || 0); },
    bumpReloadCount() { sessionStorage.setItem(Config.storageKeys.reloadCount, (Store.getReloadCount() + 1)); },
    getFeatureConf() {
      const raw = localStorage.getItem(Config.storageKeys.feature);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        autoAI: saved.autoAI ?? false,
        autoComment: saved.autoComment ?? false,
      };
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
      return conf;
    },
    setFeatureConf(conf) {
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
    },
    getPendingAutoStart() {
      // 存 sessionStorage：多标签同时刷不同课程时互不影响
      // （同标签整页刷新保留；window.open 新标签会克隆 opener 的 sessionStorage）
      const raw = sessionStorage.getItem(Config.storageKeys.pendingAutoStart);
      const saved = Utils.safeJSONParse(raw, null);
      if (!saved || !saved.classroomId || !saved.ts) return null;
      if (Date.now() - saved.ts > 30 * 60 * 1000) {
        sessionStorage.removeItem(Config.storageKeys.pendingAutoStart);
        return null;
      }
      return saved;
    },
    setPendingAutoStart(classroomId = '', returnUrl = '') {
      if (!classroomId) return;
      const prev = this.getPendingAutoStart() || {};
      sessionStorage.setItem(Config.storageKeys.pendingAutoStart, JSON.stringify({
        classroomId,
        returnUrl: returnUrl || prev.returnUrl || '',
        ts: Date.now()
      }));
    },
    clearPendingAutoStart() {
      sessionStorage.removeItem(Config.storageKeys.pendingAutoStart);
    },
    // ---- 多标签课程占用：防止两个标签刷同一门课 ----
    getTabId() {
      let id = sessionStorage.getItem('ykt_tab_id');
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem('ykt_tab_id', id);
      }
      return id;
    },
    getClaims() {
      const saved = Utils.safeJSONParse(localStorage.getItem('ykt_claims'), {}) || {};
      const now = Date.now();
      let dirty = false;
      for (const k of Object.keys(saved)) {
        if (now - (saved[k] && saved[k].ts || 0) > 10 * 60 * 1000) { delete saved[k]; dirty = true; }
      }
      if (dirty) localStorage.setItem('ykt_claims', JSON.stringify(saved));
      return saved;
    },
    claimCourse(classroomId) {
      if (!classroomId) return true;
      const claims = this.getClaims();
      const me = this.getTabId();
      const cur = claims[classroomId];
      if (cur && cur.tab !== me) return false;
      claims[classroomId] = { tab: me, ts: Date.now() };
      localStorage.setItem('ykt_claims', JSON.stringify(claims));
      return true;
    },
    heartbeatClaim(classroomId) {
      if (!classroomId) return;
      const claims = this.getClaims();
      const me = this.getTabId();
      if (claims[classroomId] && claims[classroomId].tab === me) {
        claims[classroomId].ts = Date.now();
        localStorage.setItem('ykt_claims', JSON.stringify(claims));
      }
    },
    unclaimCourse(classroomId) {
      if (!classroomId) return;
      const claims = this.getClaims();
      if (claims[classroomId] && claims[classroomId].tab === this.getTabId()) {
        delete claims[classroomId];
        localStorage.setItem('ykt_claims', JSON.stringify(claims));
      }
    },
    // 被其他标签占用中的课程对应的卡片 key 集合（选课时要避开）
    claimedCardKeys() {
      const claims = this.getClaims();
      const me = this.getTabId();
      const map = (this.getBatch() || {}).map || {};
      const keys = new Set();
      for (const cid of Object.keys(claims)) {
        if (claims[cid].tab !== me && map[cid]) keys.add(map[cid]);
      }
      return keys;
    },
  };

  // ---- UI 面板 ----
  // ---- 悬浮控制台（深色 HUD，iframe 隔离防 SPA 样式污染） ----
  function createPanel() {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '40px';
    iframe.style.left = '40px';
    iframe.style.width = '560px';
    iframe.style.height = '396px';
    iframe.style.zIndex = '999999';
    iframe.style.border = '1px solid rgba(255,255,255,.12)';
    iframe.style.borderRadius = '14px';
    iframe.style.overflow = 'hidden';
    iframe.style.boxShadow = '0 12px 40px rgba(0,0,0,.45)';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('id', 'ykt-hud-frame');
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) throw new Error('面板挂载点不存在');
    mountTarget.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`
      <style>
        * { box-sizing: border-box; }
        html, body { overflow: hidden; margin: 0; padding: 0; height: 100%;
          font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          background: transparent; }

        .hud-mini {
          position: absolute; inset: 0; display: none;
          background: linear-gradient(135deg, #1e2a4a, #0f1626);
          color: #7ea6ff; font-size: 24px; text-align: center; line-height: 62px;
          border-radius: 12px; cursor: pointer; user-select: none;
        }
        .hud-mini.show { display: block; }

        .hud {
          position: absolute; inset: 0; display: flex; flex-direction: column;
          background: linear-gradient(160deg, #141b2e 0%, #0d1220 100%);
          color: #dce3f5; border-radius: 14px; overflow: hidden;
        }

        .hud-head {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 12px; cursor: move; user-select: none;
          background: rgba(255,255,255,.04); border-bottom: 1px solid rgba(255,255,255,.07);
        }
        .hud-head .ttl { font-size: 13px; font-weight: 600; letter-spacing: .5px; flex: 1; }
        .hud-dot {
          width: 9px; height: 9px; border-radius: 50%; background: #5a6478;
          box-shadow: 0 0 6px currentColor; transition: .3s;
        }
        .hud-dot.run { background: #3ddc84; color: #3ddc84; }
        .hud-dot.hold { background: #ffb020; color: #ffb020; }
        .hud-state { font-size: 11px; color: #8b96b8; margin-right: 4px; }
        .hud-icon {
          width: 20px; height: 20px; line-height: 20px; text-align: center;
          color: #8b96b8; border-radius: 5px; cursor: pointer; font-size: 13px;
        }
        .hud-icon:hover { background: rgba(255,255,255,.12); color: #fff; }

        .hud-card {
          margin: 10px 12px 6px; padding: 10px 12px;
          background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08);
          border-radius: 10px;
        }
        .hud-course {
          font-size: 13px; font-weight: 600; color: #fff;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .hud-idx { font-size: 11px; color: #7ea6ff; float: right; }
        .hud-bar-row { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
        .hud-bar-row .bar-tag { font-size: 10px; color: #8b96b8; width: 28px; flex-shrink: 0; }
        .hud-bar-row .bar-num { font-size: 10px; color: #8b96b8; width: 46px; text-align: right; flex-shrink: 0; }
        .hud-bar {
          flex: 1; height: 7px; border-radius: 4px;
          background: rgba(255,255,255,.08); overflow: hidden;
        }
        .hud-fill {
          height: 100%; width: 0%; border-radius: 4px;
          background: linear-gradient(90deg, #3d8bff, #3ddc84);
          transition: width .6s ease;
        }
        .hud-fill.done { background: linear-gradient(90deg, #ffd76e, #ffb020); }
        .hud-fill.work { background: linear-gradient(90deg, #e5484d, #ff8f93); }
        .hud-meta { margin-top: 7px; font-size: 11px; color: #8b96b8; display: flex; gap: 12px; }

        .hud-answer {
          display: none; margin: 0 12px 6px; padding: 8px 10px; border-radius: 8px;
          background: rgba(255,215,110,.10); border: 1px solid rgba(255,215,110,.45);
          gap: 10px; align-items: baseline; font-size: 12.5px; line-height: 1.5;
        }
        .hud-answer.show { display: flex; }
        #hud-ans-q { color: #ffd76e; font-weight: 600; flex-shrink: 0; }
        #hud-ans-a { color: #fff; word-break: break-all; }
        .hud-btn.active { background: #b8860b; color: #fff; }

        .hud-feed-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 2px 12px; font-size: 11px; color: #8b96b8;
        }
        .hud-feed {
          flex: 1; margin: 4px 12px; padding: 6px 8px; min-height: 0;
          list-style: none; overflow-y: auto; font-size: 11.5px; line-height: 1.7;
          background: rgba(0,0,0,.25); border-radius: 8px;
        }
        .hud-feed::-webkit-scrollbar { width: 5px; }
        .hud-feed::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 3px; }
        .hud-feed li { color: #b9c4e0; border-bottom: 1px dashed rgba(255,255,255,.05); padding: 1px 0; }
        .hud-feed li:last-child { border-bottom: none; color: #eaf0ff; }

        .hud-ctl { display: flex; gap: 8px; padding: 0 12px; }
        .hud-btn {
          flex: 1; border: none; border-radius: 8px; color: #fff; cursor: pointer;
          padding: 8px 0; font-size: 12.5px; font-weight: 600; transition: .15s;
        }
        .hud-btn:hover { filter: brightness(1.2); transform: translateY(-1px); }
        #btn-run { background: #2f7bff; }
        #btn-hold { background: #8b5cf6; }
        #btn-halt { background: #4a5570; }

        .hud-modes {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 12px 0; gap: 10px;
        }
        .work-switch { display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer; user-select: none; }
        .work-switch input { display: none; }
        .work-switch .track {
          width: 32px; height: 17px; border-radius: 9px; background: #3a4358;
          position: relative; transition: .2s; flex-shrink: 0;
        }
        .work-switch .track::after {
          content: ''; position: absolute; left: 2px; top: 2px; width: 13px; height: 13px;
          background: #fff; border-radius: 50%; transition: left .2s;
        }
        .work-switch input:checked + .track { background: #e5484d; }
        .work-switch input:checked + .track::after { left: 17px; }
        .work-switch .wl { color: #b9c4e0; }
        .work-switch.on .wl { color: #ff8f93; font-weight: 600; }
        #rate-select {
          background: #1c2742; color: #dce3f5; border: 1px solid rgba(255,255,255,.15);
          border-radius: 7px; font-size: 12px; padding: 4px 8px; cursor: pointer;
        }

        .hud-sub { display: flex; gap: 8px; padding: 8px 12px 10px; }
        .hud-sub .hud-btn {
          background: rgba(255,255,255,.08); color: #b9c4e0;
          font-weight: 400; font-size: 11.5px; padding: 6px 0;
        }
        .hud-sub .hud-btn:hover { color: #fff; }

        .hud-cfg {
          display: none; position: absolute; top: 38px; left: 0; width: 100%; height: calc(100% - 38px);
          background: #141b2e; z-index: 99; padding: 14px; overflow-y: auto;
        }
        .cfg-item { margin-bottom: 12px; }
        .cfg-item label { display: block; margin-bottom: 4px; font-size: 11.5px; color: #8b96b8; }
        .cfg-item input[type="text"], .cfg-item input[type="password"], .cfg-item select {
          width: 100%; padding: 7px; border: 1px solid rgba(255,255,255,.15); border-radius: 6px;
          background: #1c2742; color: #dce3f5; font-size: 12px;
        }
        .cfg-item .chk { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #b9c4e0; cursor: pointer; }
        .cfg-foot { display: flex; justify-content: center; gap: 10px; margin-top: 10px; }
        .cfg-foot button { border: none; border-radius: 6px; padding: 6px 16px; font-size: 12px; cursor: pointer; color: #fff; }
        #cfg-save { background: #2f7bff; }
        #cfg-close { background: #4a5570; }
      </style>

      <div class="hud-mini" id="hud-mini">🎓</div>
      <div class="hud" id="hud">
        <div class="hud-head" id="hud-head">
          <span class="hud-dot" id="hud-dot"></span>
          <span class="ttl">雨课堂学习助手 Pro</span>
          <span class="hud-state" id="hud-state">待机</span>
          <span class="hud-icon" id="help-btn" title="关于">?</span>
          <span class="hud-icon" id="mini-btn" title="最小化">—</span>
        </div>
        <div class="hud-card">
          <span class="hud-idx" id="hud-idx">—</span>
          <div class="hud-course" id="hud-course">等待识别课程…</div>
          <div class="hud-bar-row">
            <span class="bar-tag">视频</span>
            <div class="hud-bar"><div class="hud-fill" id="hud-fill"></div></div>
            <span class="bar-num" id="hud-vnum">—/—</span>
          </div>
          <div class="hud-bar-row" id="hud-wrow" style="display:none">
            <span class="bar-tag">作业</span>
            <div class="hud-bar"><div class="hud-fill work" id="hud-wfill"></div></div>
            <span class="bar-num" id="hud-wnum">—/—</span>
          </div>
          <div class="hud-meta">
            <span id="hud-leaf">—</span>
            <span id="hud-cur"></span>
            <span id="hud-time">⏱ 00:00:00</span>
          </div>
        </div>
        <div class="hud-answer" id="hud-answer"><span id="hud-ans-q"></span><span id="hud-ans-a"></span></div>
        <div class="hud-feed-head"><span>运行日志</span><span class="hud-icon" id="feed-fold" title="折叠/展开">▾</span></div>
        <ul class="hud-feed" id="hud-feed"></ul>
        <div class="hud-ctl">
          <button class="hud-btn" id="btn-run">▶ 开始</button>
          <button class="hud-btn" id="btn-hold">⏸ 暂停</button>
          <button class="hud-btn" id="btn-halt">⏹ 停止</button>
        </div>
        <div class="hud-modes">
          <label class="work-switch" id="work-switch" title="⚠ 仅限内置题库的两门课（科研伦理/生物医药）。开启后遇到课后作业会自动勾选并提交，提交不可撤销！">
            <input type="checkbox" id="work-toggle"><span class="track"></span><span class="wl">⚠ 作业代答</span>
          </label>
          <select id="rate-select" title="视频倍速">
            <option value="2">2x 倍速</option>
            <option value="random">拟人随机</option>
            <option value="1">1x 原速</option>
            <option value="1.5">1.5x</option>
            <option value="2.5">2.5x</option>
            <option value="3">3x 极速</option>
          </select>
        </div>
        <div class="hud-sub">
          <button class="hud-btn" id="btn-assist" title="半自动模式：暂停刷课推进，面板逐题显示题库答案，由你亲自勾选提交。仅做题，不刷视频。">📋 答题助手</button>
          <button class="hud-btn" id="btn-cfg">⚙ AI 设置</button>
          <button class="hud-btn" id="btn-wipe">🗑 清缓存</button>
          <button class="hud-btn" id="btn-refresh">↻ 重载</button>
        </div>
        <div class="hud-cfg" id="cfg-pane">
          <div class="cfg-item"><label>AI API 地址</label><input type="text" id="cfg-url"></div>
          <div class="cfg-item"><label>API Key</label><input type="password" id="cfg-key"></div>
          <div class="cfg-item"><label>模型</label><input type="text" id="cfg-model"></div>
          <div class="cfg-item"><label>API 格式</label>
            <select id="cfg-format">
              <option value="openai">OpenAI 兼容</option>
              <option value="claude">Claude</option>
            </select>
          </div>
          <div class="cfg-item"><label>鉴权方式</label>
            <select id="cfg-auth">
              <option value="bearer">Bearer Token</option>
              <option value="x-api-key">x-api-key</option>
            </select>
          </div>
          <div class="cfg-item"><label class="chk"><input type="checkbox" id="feat-ai">启用 AI 自动答题（非题库课程才用）</label></div>
          <div class="cfg-item"><label class="chk"><input type="checkbox" id="feat-comment">启用自动评论（讨论区）</label></div>
          <div class="cfg-foot">
            <button id="cfg-save">保存</button>
            <button id="cfg-close">关闭</button>
          </div>
        </div>
      </div>
    `);
    doc.close();

    const ui = {
      panel: doc.getElementById('hud'),
      head: doc.getElementById('hud-head'),
      dot: doc.getElementById('hud-dot'),
      state: doc.getElementById('hud-state'),
      course: doc.getElementById('hud-course'),
      idx: doc.getElementById('hud-idx'),
      fill: doc.getElementById('hud-fill'),
      vnum: doc.getElementById('hud-vnum'),
      wrow: doc.getElementById('hud-wrow'),
      wfill: doc.getElementById('hud-wfill'),
      wnum: doc.getElementById('hud-wnum'),
      answerBar: doc.getElementById('hud-answer'),
      ansQ: doc.getElementById('hud-ans-q'),
      ansA: doc.getElementById('hud-ans-a'),
      leaf: doc.getElementById('hud-leaf'),
      cur: doc.getElementById('hud-cur'),
      time: doc.getElementById('hud-time'),
      feed: doc.getElementById('hud-feed'),
      feedFold: doc.getElementById('feed-fold'),
      btnRun: doc.getElementById('btn-run'),
      btnHold: doc.getElementById('btn-hold'),
      btnHalt: doc.getElementById('btn-halt'),
      btnCfg: doc.getElementById('btn-cfg'),
      btnWipe: doc.getElementById('btn-wipe'),
      btnRefresh: doc.getElementById('btn-refresh'),
      btnAssist: doc.getElementById('btn-assist'),
      workSwitch: doc.getElementById('work-switch'),
      workToggle: doc.getElementById('work-toggle'),
      rateSelect: doc.getElementById('rate-select'),
      cfgPane: doc.getElementById('cfg-pane'),
      cfgUrl: doc.getElementById('cfg-url'),
      cfgKey: doc.getElementById('cfg-key'),
      cfgModel: doc.getElementById('cfg-model'),
      cfgFormat: doc.getElementById('cfg-format'),
      cfgAuth: doc.getElementById('cfg-auth'),
      featAi: doc.getElementById('feat-ai'),
      featComment: doc.getElementById('feat-comment'),
      cfgSave: doc.getElementById('cfg-save'),
      cfgClose: doc.getElementById('cfg-close'),
      helpBtn: doc.getElementById('help-btn'),
      miniBtn: doc.getElementById('mini-btn'),
      hudMini: doc.getElementById('hud-mini'),
    };

    // ---- 拖拽（头部抓手） ----
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const hostWindow = iframe.contentWindow.parent || window;
    const onMove = e => {
      if (!dragging) return;
      const maxLeft = hostWindow.innerWidth - 60, maxTop = hostWindow.innerHeight - 60;
      iframe.style.left = Math.min(Math.max(0, startLeft + e.clientX - startX), maxLeft) + 'px';
      iframe.style.top = Math.min(Math.max(0, startTop + e.clientY - startY), maxTop) + 'px';
    };
    const stopDrag = () => { dragging = false; iframe.style.transition = ''; };
    ui.head.addEventListener('mousedown', e => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseFloat(iframe.style.left) || iframe.getBoundingClientRect().left;
      startTop = parseFloat(iframe.style.top) || iframe.getBoundingClientRect().top;
      iframe.style.transition = 'none';
    });
    hostWindow.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('blur', stopDrag);

    // ---- 最小化 / 还原 ----
    const normalSize = { width: parseFloat(iframe.style.width), height: parseFloat(iframe.style.height) };
    const miniSize = 64;
    let isMinimized = false;
    const enterMini = () => {
      if (isMinimized) return;
      isMinimized = true;
      ui.panel.style.display = 'none';
      ui.hudMini.classList.add('show');
      iframe.style.width = miniSize + 'px';
      iframe.style.height = miniSize + 'px';
      iframe.style.borderRadius = '14px';
    };
    const exitMini = () => {
      if (!isMinimized) return;
      isMinimized = false;
      ui.panel.style.display = '';
      ui.hudMini.classList.remove('show');
      iframe.style.width = normalSize.width + 'px';
      iframe.style.height = normalSize.height + 'px';
    };
    ui.miniBtn.addEventListener('click', enterMini);
    ui.hudMini.addEventListener('click', exitMini);
    ui.helpBtn.addEventListener('click', () => {
      window.parent.alert('雨课堂学习助手 Pro v' + Config.version + '\n基于开源雨课堂脚本社区增强（GPL3）\n刷课 · 进度仪表盘 · 可选作业代答');
    });

    // ---- 日志折叠 ----
    let feedFolded = false;
    ui.feedFold.addEventListener('click', () => {
      feedFolded = !feedFolded;
      ui.feed.style.display = feedFolded ? 'none' : '';
      ui.feedFold.innerText = feedFolded ? '▸' : '▾';
    });

    // ---- 镜像日志到 window：面板 iframe 被 SPA 销毁后仍可追踪 ----
    const mirror = message => {
      try {
        window.__yktLog = (window.__yktLog || []).concat(String(message)).slice(-200);
      } catch (_) { }
    };
    const pushFeed = (text, cls) => {
      const li = doc.createElement('li');
      li.innerText = text;
      ui.feed.appendChild(li);
      while (ui.feed.children.length > 80) ui.feed.removeChild(ui.feed.firstChild);
      if (ui.feed.lastElementChild) ui.feed.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };
    const log = message => { mirror(message); pushFeed('· ' + message); };
    const warn = message => { mirror('⚠️警告：' + message); pushFeed('⚠️ ' + message); };
    const error = message => { mirror('🚨报错：' + message); pushFeed('🚨 ' + message); };

    // ---- 仪表盘自采集（1.2s/次，读父页面 DOM，不侵入 runner） ----
    const fmtDur = ms => {
      const s = Math.floor(ms / 1000);
      const p = n => String(n).padStart(2, '0');
      return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
    };
    const fmtAns = a => {
      if (!a) return '题库缺失';
      if (a === 'T') return '√（对）';
      if (a === 'F') return '×（错）';
      return '选 ' + String(a).split('').join('·');
    };
    const tick = () => {
      try {
        const hostDoc = window.parent.document;
        const leaves = [...hostDoc.querySelectorAll('.nav-item-leaf-box')];
        const isDoneEl = el => !!el.querySelector('.icon-yuanquangou-mianzhuang');
        const textOf = el => (el.innerText || '').trim();
        // 分类统计：视频/音频 vs 作业 vs 其它（讨论/考试/图文不计入）
        const media = leaves.filter(el => /^(视频|音频)/.test(textOf(el)));
        const works = leaves.filter(el => /^作业/.test(textOf(el)));
        const vDone = media.filter(isDoneEl).length;
        const wDone = works.filter(isDoneEl).length;
        const activeIdx = leaves.findIndex(el => el.firstChild && el.firstChild.classList && el.firstChild.classList.contains('is-active'));
        const batch = Store.getBatch();
        const cards = hostDoc.querySelectorAll('.lesson-cardS').length;
        const ansMode = Store.isAnswerMode();
        // 课程名：batch.map 卡片文本最可靠 → title 去站点后缀 → 兜底
        let course = '';
        const cidM = location.pathname.match(/lms-graph\/(\d+)/) || location.pathname.match(/\/lms\/[^/]+\/(\d+)/);
        if (cidM && batch && batch.map && batch.map[cidM[1]]) {
          course = String(batch.map[cidM[1]]).split('\n')[0].replace(/\s+/g, ' ').trim();
        }
        if (!course) {
          const t = (hostDoc.title || '').replace(/[-_—丨|].*$/, '').trim();
          if (t && !/雨课堂|学习空间|学堂在线/.test(t)) course = t;
        }
        if (!course) course = '课程页面';
        // 状态灯
        const paused = Store.isPaused();
        const working = ui.btnRun.innerText !== '▶ 开始';
        ui.dot.className = 'hud-dot ' + (paused ? 'hold' : working ? 'run' : '');
        ui.state.innerText = paused ? '已暂停' : working ? '运行中' : '待机';
        // 课程与进度（视频条 = 主条；作业条仅在作业代答开启时显示）
        const total = media.length || leaves.length;
        if (total) {
          ui.course.innerText = course;
          const vAll = vDone === media.length && media.length > 0;
          const pct = media.length ? Math.round(vDone / media.length * 100) : 0;
          ui.fill.style.width = (vAll ? 100 : pct) + '%';
          ui.fill.classList.toggle('done', vAll);
          ui.vnum.innerText = `${vDone}/${media.length}`;
          ui.leaf.innerText = vAll ? '视频已刷完 🎉' : `视频 ${vDone}/${media.length}`;
          ui.cur.innerText = activeIdx >= 0 ? `当前第 ${activeIdx + 1} 节` : '';
          ui.wrow.style.display = ansMode ? 'flex' : 'none';
          if (ansMode) {
            const wPct = works.length ? Math.round(wDone / works.length * 100) : 0;
            ui.wfill.style.width = wPct + '%';
            ui.wnum.innerText = `${wDone}/${works.length}`;
          }
        } else if (cards) {
          ui.course.innerText = `课程列表 · 共 ${cards} 门`;
          ui.fill.style.width = '0%';
          ui.fill.classList.remove('done');
          ui.vnum.innerText = '—/—';
          ui.wrow.style.display = 'none';
          ui.leaf.innerText = '等待选课';
          ui.cur.innerText = '';
        }
        // 批量门次
        if (batch) {
          const finished = ((batch.done || []).length);
          const est = Math.max(cards, finished + 1);
          ui.idx.innerText = `第 ${Math.min(finished + 1, est)}/${est} 门 · 已完成 ${finished}`;
        } else if (total) {
          ui.idx.innerText = '单课模式';
        }
        // 计时
        const t0 = Number(sessionStorage.getItem('ykt_stats_t0') || 0);
        ui.time.innerText = '⏱ ' + (t0 ? fmtDur(Date.now() - t0) : '00:00:00');
        // 作业代答警示态 + 答题助手激活态
        ui.workSwitch.classList.toggle('on', ansMode);
        const assist = Store.isAssistMode();
        ui.btnAssist.classList.toggle('active', assist);
        // 答题助手横幅：只读提示，不代点
        if (!assist) {
          ui.answerBar.classList.remove('show');
        } else {
          ui.answerBar.classList.add('show');
          const bk = cidM ? QUESTION_BANK[cidM[1]] : null;
          if (!bk) {
            ui.ansQ.innerText = '无题库';
            ui.ansA.innerText = '本课程不在白名单（仅科研伦理/生物医药）';
          } else {
            const root = CourseDom.getExerciseContainer();
            if (!root) {
              ui.ansQ.innerText = '待进入';
              ui.ansA.innerText = '未检测到作业页——请手动进入本课程作业课时';
            } else {
              const resolved = bankAnswersFor(bk, CourseDom.getActiveLeafTitle());
              if (!resolved) {
                ui.ansQ.innerText = '未识别';
                ui.ansA.innerText = '未能从课时标题定位章节，题库无匹配';
              } else {
                const tabs = CourseDom.getExerciseQuestionTabs(root);
                if (tabs.length) {
                  const ai = tabs.findIndex(t => /active|current|selected|is-active/.test(t.className));
                  const idx = ai >= 0 ? ai : 0;
                  const a = resolved.answers[idx];
                  ui.ansQ.innerText = `第 ${idx + 1}/${Math.max(tabs.length, resolved.answers.length)} 题`;
                  ui.ansA.innerText = a ? `答案：${fmtAns(a)}` : '题库缺此题，请自行作答';
                } else {
                  ui.ansQ.innerText = `全卷 ${resolved.answers.length} 题`;
                  ui.ansA.innerText = resolved.answers.map((a, i) => `${i + 1}.${a ? fmtAns(a) : '?'}`).join('　');
                }
              }
            }
          }
        }
      } catch (_) { }
    };
    setInterval(tick, 1200);
    setTimeout(tick, 300);

    // ---- AI 配置页 ----
    const defaultAI = { url: 'https://api.deepseek.com/chat/completions', key: 'sk-xxxxxxx', model: 'deepseek-chat', apiFormat: 'openai', authMethod: 'bearer' };
    const loadAIConf = () => {
      const saved = Store.getAIConf();
      ui.cfgUrl.value = saved.url || defaultAI.url;
      ui.cfgKey.value = saved.key || defaultAI.key;
      ui.cfgModel.value = saved.model || defaultAI.model;
      ui.cfgFormat.value = saved.apiFormat || defaultAI.apiFormat;
      ui.cfgAuth.value = saved.authMethod || defaultAI.authMethod;
    };
    const loadFeatureConf = () => {
      const saved = Store.getFeatureConf();
      ui.featAi.checked = saved.autoAI;
      ui.featComment.checked = saved.autoComment;
    };
    loadAIConf();
    loadFeatureConf();
    ui.btnCfg.onclick = () => { loadAIConf(); loadFeatureConf(); ui.cfgPane.style.display = 'block'; };
    ui.cfgClose.onclick = () => { ui.cfgPane.style.display = 'none'; };
    ui.cfgSave.onclick = () => {
      Store.setAIConf({ url: ui.cfgUrl.value.trim(), key: ui.cfgKey.value.trim(), model: ui.cfgModel.value.trim(), apiFormat: ui.cfgFormat.value, authMethod: ui.cfgAuth.value });
      Store.setFeatureConf({ autoAI: ui.featAi.checked, autoComment: ui.featComment.checked });
      ui.cfgPane.style.display = 'none';
      log('AI 配置已保存');
    };

    // ---- 控制按钮 ----
    ui.btnWipe.onclick = () => {
      Store.removeProgress(window.parent.location.href);
      localStorage.removeItem(Config.storageKeys.proClassCount);
      Store.clearPendingAutoStart();
      log('已清除当前课程的刷课进度缓存');
    };
    ui.btnHalt.onclick = () => {
      Store.clearPendingAutoStart();
      Store.clearBatch();
      Store.setPaused();
      log('已停止刷课，页面即将刷新');
      window.parent.location.reload();
    };
    ui.btnRefresh.onclick = () => {
      Store.clearPaused();
      Store.setPendingAutoStart(Utils.getCurrentClassroomId());
      log('正在重新加载脚本...');
      window.parent.location.reload();
    };
    ui.btnHold.onclick = () => {
      Store.setPaused();
      log('已暂停（当前集播完后停下，点"开始"恢复）');
      ui.btnRun.innerText = '▶ 开始';
      running = false;
    };

    // ---- 作业代答开关（全自动：混在刷课流程里自动勾选并提交） ----
    ui.workToggle.checked = Store.isAnswerMode();
    ui.workToggle.onchange = () => {
      if (!ui.workToggle.checked) {
        Store.setAnswerMode(false);
        log('作业代答已关闭，恢复纯刷课（作业跳过不答）');
        return;
      }
      const ok = window.parent.confirm(
        '⚠ 开启「作业代答」（全自动）？\n\n'
        + '脚本将在刷课过程中自动勾选并【提交】以下两门课的课后作业：\n'
        + '· 科研伦理与学术规范（第一~六章）\n'
        + '· 生物医药实验室安全知识（第一~九部分）\n\n'
        + '提交后无法修改！题库如有缺题会留空不提交并提示。\n'
        + '其它课程与期末考试不受影响。与「答题助手」（半自动）互斥。\n\n确认开启？');
      if (!ok) { ui.workToggle.checked = false; return; }
      if (Store.isAssistMode()) { Store.setAssistMode(false); log('已自动关闭答题助手（与作业代答互斥）'); }
      Store.setAnswerMode(true);
      warn('作业代答已开启：白名单课程作业将自动勾选并提交');
    };

    // ---- 答题助手（半自动：只显示答案提示，由你亲自勾选提交；刷课推进暂停） ----
    ui.btnAssist.onclick = () => {
      if (Store.isAssistMode()) {
        Store.setAssistMode(false);
        log('答题助手已关闭。点「▶ 开始」恢复刷课推进');
        return;
      }
      const ok = window.parent.confirm(
        '📋 开启「答题助手」（半自动）？\n\n'
        + '这是只做题的独立模式，与刷视频互不干扰：\n'
        + '· 刷课推进会暂停（不会自动跳到下一节）\n'
        + '· 你手动进入作业课时，面板金色横幅逐题显示题库答案\n'
        + '· 由你亲自勾选并提交——脚本只读不代点\n'
        + '· 与「作业代答」（全自动混刷）互斥，已开会自动关闭\n\n确认开启？');
      if (!ok) return;
      if (Store.isAnswerMode()) { Store.setAnswerMode(false); ui.workToggle.checked = false; log('已自动关闭作业代答（与答题助手互斥）'); }
      Store.setAssistMode(true);
      log('📋 答题助手已开启：推进暂停，请手动进入作业课时，看金色横幅抄答案');
    };

    // ---- 倍速偏好 ----
    ui.rateSelect.value = Store.getSpeedPref();
    ui.rateSelect.onchange = () => {
      Store.setSpeedPref(ui.rateSelect.value);
      applySpeedPref();
      const v = CourseDom.getMedia();
      if (v) { try { Player.pinSpeed(v, Config.playbackRate); } catch (_) { } }
      log(`倍速已切换：${ui.rateSelect.options[ui.rateSelect.selectedIndex].text}`);
    };

    let startHandler = null;
    let running = false;
    const invokeStart = () => {
      if (running) { log('已在运行中'); return; }
      running = true;
      Store.clearPaused();
      if (!sessionStorage.getItem('ykt_stats_t0')) sessionStorage.setItem('ykt_stats_t0', String(Date.now()));
      log('启动中...');
      ui.btnRun.innerText = '● 运行中';
      startHandler && startHandler();
    };

    return {
      ...ui,
      log,
      warn,
      error,
      setStartHandler(fn) {
        startHandler = fn;
        ui.btnRun.onclick = invokeStart;
      },
      start() { invokeStart(); },
      resetStartButton(text = '开始刷课') {
        ui.btnRun.innerText = text === '刷课中...' || text === '开始刷课' ? '▶ 开始' : text;
        if (text !== '刷课中...') running = false;
      }
    };
  }

  // ---- 播放器工具 ----
  const Player = {
    isNearEnd(media, threshold = 1) {
      if (!media) return false;
      const duration = Number(media.duration || 0);
      const currentTime = Number(media.currentTime || 0);
      return Number.isFinite(duration) && duration > 1 && currentTime > 0 && duration - currentTime <= threshold;
    },
    applySpeed() {
      const rate = Config.playbackRate;
      const speedBtn = document.querySelector('xt-speedlist xt-button') || document.getElementsByTagName('xt-speedlist')[0]?.firstElementChild?.firstElementChild;
      const speedWrap = document.getElementsByTagName('xt-speedbutton')[0];
      if (speedBtn && speedWrap) {
        speedBtn.setAttribute('data-speed', rate);
        speedBtn.setAttribute('keyt', `${rate}`);
        speedBtn.innerText = `${rate}x`;
        const mousemove = document.createEvent('MouseEvent');
        mousemove.initMouseEvent('mousemove', true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
        speedWrap.dispatchEvent(mousemove);
        speedBtn.click();
      } else if (document.querySelector('video')) {
        document.querySelector('video').playbackRate = rate;
      }
    },
    mute() {
      // 不点播放器静音按钮（是切换键，已静音时会反向取消）；直接改媒体属性最稳
      const video = document.querySelector('video');
      if (video) { video.volume = 0; video.muted = true; }
    },
    // xt 播放器会强制回写 playbackRate：把元素属性改成"只吞不写"，站点回写被吞，我方通过原生 setter 直写
    _rateDesc: null,
    pinSpeed(media, rate) {
      if (!media) return;
      if (!Player._rateDesc) Player._rateDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
      const desc = Player._rateDesc;
      if (!media.__yktRatePin) {
        try {
          Object.defineProperty(media, 'playbackRate', {
            configurable: true,
            get() { return desc.get.call(this); },
            set() { /* 站点回写被吞掉 */ }
          });
          media.__yktRatePin = true;
        } catch (e) { /* 少数环境不允许重定义，退回普通赋值 */ }
      }
      try { desc.set.call(media, rate); } catch (e) { try { media.playbackRate = rate; } catch (_) { } }
    },
    applyMediaDefault(media) {
      if (!media) return;
      media.play();
      media.volume = 0;
      this.pinSpeed(media, Config.playbackRate);
    },
    observePause(video, shouldResume = () => true) {
      if (!video) return () => { };
      const canResume = () => shouldResume() && !video.ended && !this.isNearEnd(video);
      // 自动播放
      const playVideo = () => {
        if (!canResume()) return;
        video.play().catch(e => {
          if (!canResume()) return;
          console.warn('自动播放失败:', e);
          setTimeout(playVideo, 3000);
        });
      };
      playVideo();
      this.pinSpeed(video, Config.playbackRate);
      // 直接监听 pause 事件，不依赖播放器 UI 元素
      const onPause = () => { if (canResume()) playVideo(); };
      video.addEventListener('pause', onPause);
      // 定时兜底：防止 pause 事件被拦截 + 周期重申倍速（防站点回写）
      const timer = setInterval(() => {
        this.pinSpeed(video, Config.playbackRate);
        if (video.paused && canResume()) playVideo();
      }, 5000);
      // 播放器 UI 观察：按钮被点击暂停时 tip 变为「播放」
      const target = document.getElementsByClassName('play-btn-tip')[0];
      let observer = null;
      if (target) {
        observer = new MutationObserver(list => {
          for (const mutation of list) {
            if (mutation.type === 'childList' && target.innerText === '播放' && canResume()) {
              video.play();
            }
          }
        });
        observer.observe(target, { childList: true });
      }
      return () => {
        video.removeEventListener('pause', onPause);
        clearInterval(timer);
        if (observer) observer.disconnect();
      };
    },
    waitForEnd(media, timeout = 0) {
      return new Promise(resolve => {
        if (!media) return resolve();
        if (media.ended) return resolve();
        let timer;
        const onEnded = () => {
          clearTimeout(timer);
          resolve();
        };
        media.addEventListener('ended', onEnded, { once: true });
        if (timeout > 0) {
          timer = setTimeout(() => {
            media.removeEventListener('ended', onEnded);
            resolve();
          }, timeout);
        }
      });
    }
  };

  // ---- ai-workspace 路由工具 ----
  const CourseDom = {
    normalizeText(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    },
    isVisibleElement(element) {
      if (!element || element.nodeType !== 1) return false;
      const view = element.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    },
    getRoute() {
      const match = location.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
      if (!match) return null;
      const [, classroomId, type, leafId] = match;
      const query = new URLSearchParams(location.search);
      return {
        classroomId,
        type,
        leafId,
        nodeId: query.get('node_id') || ''
      };
    },
    getMediaCandidates() {
      return [...document.querySelectorAll('video, audio')].filter(media => {
        if (!(media instanceof HTMLMediaElement)) return false;
        const rect = media.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        return isVisible || media.tagName.toLowerCase() === 'audio';
      });
    },
    getMedia() {
      const candidates = this.getMediaCandidates();
      if (!candidates.length) return document.querySelector('video') || document.querySelector('audio');
      const score = media => {
        const rect = media.getBoundingClientRect();
        const area = rect.width * rect.height;
        const playingBoost = !media.paused && !media.ended ? 1_000_000 : 0;
        const currentBoost = Number(media.currentTime || 0);
        return playingBoost + area + currentBoost;
      };
      return [...candidates].sort((a, b) => score(b) - score(a))[0];
    },
    isPlayerDone(media, { startTime = 0, minPlayedDelta = 0 } = {}) {
      if (!media) return false;
      const currentTime = Number(media?.currentTime || 0);
      const duration = Number(media?.duration || 0);
      const playedDelta = Math.max(0, currentTime - startTime);
      if (playedDelta < minPlayedDelta) return false;
      if (media?.ended) return true;
      if (duration > 1 && currentTime > 0 && duration - currentTime <= 1) return true;
      const display = document.querySelector('.xt_video_player_current_time_display')?.innerText?.trim() || '';
      const [current, total] = display.split(' / ').map(text => text?.trim());
      return Boolean(playedDelta >= minPlayedDelta && current && total && current === total);
    },
    keepAlive(shouldResume = () => true) {
      let lastMedia = null;
      const tick = () => {
        if (!shouldResume()) return;
        const media = this.getMedia();
        if (!media) return;
        if (lastMedia !== media) {
          lastMedia = media;
          media.addEventListener('pause', tick);
        }
        media.muted = true;
        media.defaultMuted = true;
        media.volume = 0;
        Player.pinSpeed(media, Config.playbackRate);
        if (media.paused && !media.ended && !Player.isNearEnd(media)) {
          media.play().catch(() => { });
        }
      };
      const timer = setInterval(tick, 500);
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('focus', tick);
      tick();
      return () => {
        clearInterval(timer);
        if (lastMedia) lastMedia.removeEventListener('pause', tick);
        document.removeEventListener('visibilitychange', tick);
        window.removeEventListener('focus', tick);
      };
    },
    getActiveLeafTitle() {
      return document.querySelector('.leaf-item.is-active')?.innerText?.replace(/\s+/g, ' ').trim() || '';
    },
    getExerciseDocument() {
      const localHasExercise = document.querySelector('#app .container-body .container-problem')
        || document.querySelector('#app .container-problem')
        || document.querySelector('.container-problem');
      if (localHasExercise) return document;

      const frames = [...document.querySelectorAll('iframe')];
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc?.body) continue;
          if (
            doc.querySelector('.container-problem')
            || doc.querySelector('.subject-item')
            || doc.querySelector('.item-body')
          ) {
            return doc;
          }
        } catch (_) {
          // ignore cross-document access failures
        }
      }
      return null;
    },
    getExerciseContainer() {
      const exerciseDoc = this.getExerciseDocument();
      return exerciseDoc?.querySelector('#app .container-body .container-problem')
        || exerciseDoc?.querySelector('#app .container-problem')
        || exerciseDoc?.querySelector('.container-problem')
        || null;
    },
    getExerciseQuestionTabs(root = this.getExerciseContainer()) {
      if (!root) return [];
      const selectors = [
        '.subject-item.J_order',
        '.subject-item',
        '.problem-index-item',
        '.question-index-item',
        '[class*="subject-item"]',
        '[class*="problem-index"]',
        '[class*="question-index"]'
      ].join(',');
      const all = [...root.querySelectorAll(selectors)];
      return all.filter((el, index, arr) => {
        if (!this.isVisibleElement(el)) return false;
        if (arr.indexOf(el) !== index) return false;
        const text = this.normalizeText(el.innerText);
        return text && text.length <= 20;
      });
    },
    getExerciseQuestionBody(root = this.getExerciseContainer()) {
      if (!root) return null;
      const itemType = root.querySelector('.item-type');
      if (itemType?.parentElement && this.isVisibleElement(itemType.parentElement)) return itemType.parentElement;
      const selectors = [
        '.item-body',
        '.problem-content',
        '.question-content',
        '.problem-main',
        '.problem-body',
        '.question-body',
        '[class*="problem-content"]',
        '[class*="question-content"]',
        '[class*="problem-body"]',
        '[class*="question-body"]'
      ];
      for (const selector of selectors) {
        const match = [...root.querySelectorAll(selector)].find(el => this.isVisibleElement(el));
        if (match) return match;
      }
      return root;
    },
    isExerciseAnswered(root = this.getExerciseContainer()) {
      if (!root) return false;
      const disabled = root.querySelector('.el-button.el-button--info.is-disabled.is-plain')
        || root.querySelector('button[disabled]');
      if (disabled) return true;
      const statusSelectors = [
        '.result',
        '.status',
        '.answer-status',
        '[class*="result"]',
        '[class*="status"]'
      ];
      for (const selector of statusSelectors) {
        const statusNode = [...root.querySelectorAll(selector)]
          .find(el => this.isVisibleElement(el) && /已完成|已作答|已提交|回答正确|回答错误/.test(this.normalizeText(el.innerText)));
        if (statusNode) return true;
      }
      return false;
    },
    getExerciseActionButton(root = this.getExerciseContainer(), pattern = /提交|保存|确认|确定|下一题|下一道|下一步|完成本题/) {
      if (!root) return null;
      const selectors = 'button, .el-button, [role="button"], [class*="button"]';
      const nodes = [
        ...root.querySelectorAll(selectors),
        ...document.querySelectorAll(selectors)
      ];
      return nodes.find(el => this.isVisibleElement(el) && pattern.test(this.normalizeText(el.innerText)));
    },
    getAllScourse() { // 获得ai-workspace的课程列表
      const list = document?.querySelectorAll(".nav-item-leaf-box")
      if (!list) panel.warn("没有发现课程资源")
      return list
    }
  };

  // ---- 防切屏 ----
  function preventScreenCheck() {
    if (window.__yktEnvPatched) return; // 幂等：boot 与 runner 都会调用，属性只能 defineProperty 一次
    window.__yktEnvPatched = true;
    const win = unsafeWindow;
    const blackList = new Set(['visibilitychange', 'blur', 'pagehide']);
    win._addEventListener = win.addEventListener;
    win.addEventListener = (...args) => blackList.has(args[0]) ? undefined : win._addEventListener(...args);
    document._addEventListener = document.addEventListener;
    document.addEventListener = (...args) => blackList.has(args[0]) ? undefined : document._addEventListener(...args);
    Object.defineProperties(document, {
      hidden: { value: false },
      visibilityState: { value: 'visible' },
      hasFocus: { value: () => true },
      onvisibilitychange: { get: () => undefined, set: () => { } },
      onblur: { get: () => undefined, set: () => { } }
    });
    Object.defineProperties(win, {
      onblur: { get: () => undefined, set: () => { } },
      onpagehide: { get: () => undefined, set: () => { } }
    });
  }

  // ---- OCR & AI ----
  const Solver = {
    async recognize(element) {
      if (!element) return '无元素';
      try {
        panel.log('正在截图...');
        const canvas = await html2canvas(element, {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff'
        });
        panel.log('正在 OCR 识别 (首轮较慢)...');
        const { data: { text } } = await Tesseract.recognize(canvas, 'chi_sim', {
          logger: m => {
            if (m.status === 'downloading tesseract lang') {
              console.log(`正在下载语言包 ${(m.progress * 100).toFixed(0)}%`);
            }
          }
        });
        return text.replace(/\s+/g, ' ').trim();
      } catch (err) {
        console.error('OCR error:', err);
        panel.log(`OCR 失败: ${err.message || '网络错误'}`);
        return 'OCR识别出错';
      }
    },
    async askAI(ocrText, optionCount = 0) {
      const saved = Store.getAIConf();
      const API_URL = saved.url;
      const API_KEY = saved.key;
      const MODEL_NAME = saved.model;
      const API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';
      return new Promise((resolve, reject) => {
        if (!API_KEY || API_KEY.includes('sk-xxxx')) {
          const msg = '⚠️ 请在 [AI配置] 中填写有效的 API Key';
          panel.log(msg);
          reject(msg);
          return;
        }
        const maxChar = String.fromCharCode(65 + optionCount - 1);
        const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
        const prompt = `
你是专业做题助手，请分析 OCR 文本，判断题型后给出答案。
强约束：
1) 本题只有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}
2) 忽略 OCR 错误的选项字母，按出现顺序映射 A/B/C/D...
3) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错
题目内容：
${ocrText}
`;
        const systemPrompt = "你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。";

        // 构建认证 header
        const authHeader = AUTH_METHOD === 'x-api-key'
          ? { 'x-api-key': API_KEY }
          : { 'Authorization': `Bearer ${API_KEY}` };

        if (API_FORMAT === 'anthropic') {
          // Anthropic API 格式
          const headers = {
            'Content-Type': 'application/json',
            ...authHeader
          };
          // 只有原生 Anthropic API 才需要 anthropic-version，代理通常不需要
          if (API_URL.includes('api.anthropic.com')) {
            headers['anthropic-version'] = '2023-06-01';
          }
          const requestBody = {
            model: MODEL_NAME,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [
              { role: 'user', content: prompt }
            ]
          };
          // 调试日志
          console.log('[AI请求] URL:', API_URL);
          console.log('[AI请求] Headers:', headers);
          console.log('[AI请求] Body:', requestBody);
          panel.log(`请求 ${API_URL}...`);
          GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            headers,
            data: JSON.stringify(requestBody),
            data: JSON.stringify({
              model: MODEL_NAME,
              max_tokens: 1024,
              system: systemPrompt,
              messages: [
                { role: 'user', content: prompt }
              ]
            }),
            timeout: 120000, // 120秒，思考模型需要更长响应时间
            onload: res => {
              console.log('[AI响应] Status:', res.status);
              console.log('[AI响应] Response:', res.responseText);
              if (res.status === 200) {
                try {
                  const json = JSON.parse(res.responseText);
                  // Anthropic 返回格式: content[0].text
                  const answerText = json.content?.[0]?.text || json.choices?.[0]?.message?.content;
                  resolve(answerText);
                } catch (e) {
                  reject('JSON 解析失败');
                }
              } else {
                const err = `请求失败: HTTP ${res.status} - ${res.responseText}`;
                panel.log(err);
                reject(err);
              }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时')
          });
        } else {
          // OpenAI API 格式（默认）
          GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            headers: {
              'Content-Type': 'application/json',
              ...authHeader
            },
            data: JSON.stringify({
              model: MODEL_NAME,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
              ],
              temperature: 0.1
            }),
            timeout: 120000, // 120秒，思考模型需要更长响应时间
            onload: res => {
              if (res.status === 200) {
                try {
                  const json = JSON.parse(res.responseText);
                  const answerText = json.choices[0].message.content;
                  resolve(answerText);
                } catch (e) {
                  reject('JSON 解析失败');
                }
              } else {
                const err = `请求失败: HTTP ${res.status}`;
                panel.log(err);
                reject(err);
              }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时')
          });
        }
      });
    },
    // 答案文本 → 选项下标（'T'/'√'/'对'→0，'F'/'×'/'错'→1，'ABCD'→多选逐字母）
    parseAnswerIndices(answerRaw) {
      const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5 };
      const raw = String(answerRaw || '').replace(/[,，\s]/g, '').trim();
      if (/^(T|√|对|正确)$/i.test(raw)) return [0];
      if (/^(F|×|错|错误|X)$/i.test(raw)) return [1];
      const indices = [];
      for (const char of raw.toUpperCase()) {
        if (map[char] !== undefined) indices.push(map[char]);
      }
      return indices;
    },
    // 在题目容器内按答案字母勾选选项（多选逐个点 checkbox），返回实际点到的选项数
    async selectOptions(itemBodyElement, answerRaw) {
      const targetIndices = this.parseAnswerIndices(answerRaw);
      if (!targetIndices.length) return 0;
      const listContainer = itemBodyElement.querySelector('.list-inline.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled') ||
        itemBodyElement.querySelector('ul.list') ||
        itemBodyElement.querySelector('[class*="option-list"]') ||
        itemBodyElement.querySelector('[class*="answer-list"]') ||
        itemBodyElement.querySelector('ul') ||
        itemBodyElement.querySelector('[role="radiogroup"], [role="group"]');
      if (!listContainer) {
        panel.log('⚠️ 未找到选项容器');
        return 0;
      }
      const options = listContainer.querySelectorAll('li, .option-item, .answer-item, [class*="option-item"], [class*="answer-item"]');
      let picked = 0;
      for (const idx of targetIndices) {
        if (!options[idx]) continue;
        const clickable = options[idx].querySelector('label.el-radio') ||
          options[idx].querySelector('label.el-checkbox') ||
          options[idx].querySelector('.el-radio__label') ||
          options[idx].querySelector('.el-checkbox__label') ||
          options[idx].querySelector('[role="radio"]') ||
          options[idx].querySelector('[role="checkbox"]') ||
          options[idx].querySelector('input') ||
          options[idx];
        clickable.click();
        picked++;
        await Utils.sleep(150);
      }
      return picked;
    },
    clickSubmit(itemBodyElement) {
      const ownerDocument = (itemBodyElement && itemBodyElement.ownerDocument) || document;
      const roots = [itemBodyElement && itemBodyElement.parentElement, itemBodyElement, ownerDocument].filter(Boolean);
      const matchText = text => /提交|保存|确认|确定|提交答案/.test(text);
      for (const root of roots) {
        const local = root.querySelectorAll('button, .el-button, [role="button"]');
        for (const btn of local) {
          if (btn.offsetParent !== null && matchText(btn.innerText || '')) return btn;
        }
      }
      const global = ownerDocument.querySelectorAll('.el-button.el-button--primary.el-button--medium');
      for (const btn of global) {
        if (matchText(btn.innerText || '') && btn.offsetParent !== null) return btn;
      }
      return null;
    },
    async autoSelectAndSubmit(aiResponse, itemBodyElement) {
      const match = aiResponse.match(/(?:正确)?答案[：:]?\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/i);
      if (!match) {
        panel.log('⚠️ 未提取到有效选项，请人工检查');
        return;
      }
      let answerRaw = match[1].replace(/[,，]/g, '').trim();
      panel.log(`✅ AI 建议选：${answerRaw}`);
      const picked = await this.selectOptions(itemBodyElement, answerRaw);
      if (!picked) return;
      const submitBtn = this.clickSubmit(itemBodyElement);
      if (submitBtn) {
        panel.log('正在提交...');
        submitBtn.click();
      } else {
        panel.log('⚠️ 未找到提交按钮，请手动提交');
      }
    }
  };

  // ---- v2 逻辑 ----
  class LegacyRunner {
    constructor(panel) {
      this.panel = panel;
      this.baseUrl = location.href;
      const { current } = Store.getProgress(this.baseUrl);
      this.outside = current.outside;
      this.inside = current.inside;
      this.shouldStop = false;
    }

    updateProgress(outside, inside = 0) {
      this.outside = outside;
      this.inside = inside;
      Store.setProgress(this.baseUrl, outside, inside);
    }

    async waitForExternalHandoff(timeout = 1200) {
      await Utils.sleep(timeout);
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        this.shouldStop = true;
        this.panel.log('已交给新页面继续，返回目录页后会自动续跑');
        return true;
      }
      return false;
    }

    checkCompletionStatus(statusBox, statusText) {
      // 1. 检查明确的完成状态文本
      if (statusText.includes('已完成') || statusText.includes('已读')) {
        return true;
      }

      // 2. 检查明确的未完成状态文本
      if (statusText.includes('未开始') || statusText.includes('未读') || statusText.includes('进行中')) {
        return false;
      }

      // 3. 检查学习进度数字比例
      const progressMatch = statusText.match(/(\d+)\/(\d+)/);
      if (progressMatch) {
        const [, current, total] = progressMatch;
        const currentNum = parseInt(current, 10);
        const totalNum = parseInt(total, 10);

        // 根据数字进度判断：相等且大于0表示已完成
        return currentNum === totalNum && totalNum > 0;
      }

      // 默认返回false（未完成）
      return false;
    }

    async run() {
      this.panel.log(`检测到已播放到第 ${this.outside} 集，继续刷课...`);
      // 在课件页恢复时直接续播当前内容，不重新走列表流程
      if (location.pathname.includes('/studentCards/')) {
        const videoBox = document.querySelector('.video-box');
        const boxText = videoBox?.innerText || '';
        if ((videoBox || document.querySelector('video')) && !boxText.includes('已完成')) {
          this.panel.log('检测到当前课件页，直接续播当前内容');
          await this.waitCoursewareVideo();
          history.back();
          await Utils.sleep(1000);
        }
      }
      while (true) {
        await this.autoSlide();
        const list = document.querySelector('.logs-list')?.childNodes;
        if (!list || !list.length) {
          // 可能停留在课件页：跳回目录页继续，避免无限重试
          const pending = Store.getPendingAutoStart();
          const returnUrl = pending?.returnUrl
            || (pending?.classroomId ? `/v2/web/studentLog/${pending.classroomId}` : '');
          if (returnUrl && !location.pathname.includes('/studentLog/')) {
            this.panel.log('当前页面无课程列表，返回目录页继续');
            location.href = returnUrl;
            return;
          }
          this.panel.log('未找到课程列表，稍后重试');
          await Utils.sleep(2000);
          continue;
        }
        console.log(`当前集数:${this.outside}/全部集数${list.length}`);
        if (this.outside >= list.length) {
          this.panel.log('课程刷完啦 🎉');
          this.panel.resetStartButton('刷完啦~');
          Store.removeProgress(this.baseUrl);
          Store.clearPendingAutoStart();
          break;
        }
        const course = list[this.outside]?.querySelector('.content-box')?.querySelector('section');
        if (!course) {
          this.panel.log('未找到当前课程节点，跳过');
          this.updateProgress(this.outside + 1, 0);
          continue;
        }
        const type = course.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || 'piliang';
        const title = course.querySelector('h2')?.innerText?.trim() || `第${this.outside + 1}项`;

        // 预检查完成状态
        const statusBox = course.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';

        // 判断是否已完成
        let isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          this.updateProgress(this.outside + 1, 0);
          continue;
        }

        this.panel.log(`刷课状态：第 ${this.outside + 1}/${list.length} 个，类型 ${type}，标题：${title}`);
        if (type.includes('shipin')) {
          await this.handleVideo(course);
        } else if (type.includes('piliang')) {
          await this.handleBatch(course, list);
        } else if (type.includes('ketang')) {
          await this.handleClassroom(course);
        } else if (type.includes('kejian')) {
          await this.handleCourseware(course);
        } else if (type.includes('kaoshi')) {
          this.panel.log('考试区域脚本会被屏蔽，已跳过');
          this.updateProgress(this.outside + 1, 0);
        } else {
          this.panel.log('非视频/批量/课件/考试，已跳过');
          this.updateProgress(this.outside + 1, 0);
        }
        if (this.shouldStop) return;
      }
    }

    async autoSlide() {
      const frequency = Math.floor((this.outside + 1) / 20) + 1;
      for (let i = 0; i < frequency; i++) {
        Utils.scrollToBottom('.viewContainer');
        await Utils.sleep(800);
      }
    }

    async handleVideo(course) {
      course.click();
      if (await this.waitForExternalHandoff(1500)) return;
      await Utils.sleep(3000);
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const title = document.querySelector('.title')?.innerText || '视频';
      const isDeadline = document.querySelector('.box')?.innerText.includes('已过考核截止时间');
      if (isDeadline) this.panel.log(`${title} 已过截止，进度不再增加，将直接跳过`);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(document.querySelector('video'));
      await Utils.poll(() => {
        Utils.dismissPopups();
        return isDeadline || Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 5000, timeout: await Utils.getDDL() });
      stopObserve();
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1200);
    }

    async handleBatch(course, list) {
      const expandBtn = course.querySelector('.sub-info')?.querySelector('.gray')?.querySelector('span');
      if (!expandBtn) {
        this.panel.log('未找到批量展开按钮，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      expandBtn.click();
      await Utils.sleep(1200);
      const activities = list[this.outside]?.querySelector('.leaf_list__wrap')?.querySelectorAll('.activity__wrap') || [];
      let idx = this.inside;
      this.panel.log(`进入批量区，内部进度 ${idx}/${activities.length}`);
      while (idx < activities.length) {
        const item = activities[idx];
        if (!item) break;

        const tagText = item.querySelector('.tag')?.innerText || '';
        const tagHref = item.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || '';
        const title = item.querySelector('h2')?.innerText || `第${idx + 1}项`;

        // 检查当前项目的完成状态
        const statusBox = item.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';
        const isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          idx++;
          this.updateProgress(this.outside, idx);
          continue;
        }

        if (tagText === '音频') {
          idx = await this.playAudioItem(item, title, idx);
        } else if (tagHref.includes('shipin')) {
          idx = await this.playVideoItem(item, title, idx);
        } else if (tagHref.includes('tuwen') || tagHref.includes('taolun')) {
          idx = await this.autoCommentItem(item, tagHref.includes('tuwen') ? '图文' : '讨论', idx);
        } else if (tagHref.includes('zuoye')) {
          idx = await this.handleHomework(item, idx);
        } else {
          this.panel.log(`类型未知，已跳过：${title}`);
          idx++;
          this.updateProgress(this.outside, idx);
        }
        if (this.shouldStop) return;
      }
      this.updateProgress(this.outside + 1, 0);
      await Utils.sleep(1000);
    }

    async playAudioItem(item, title, idx) {
      this.panel.log(`开始播放音频：${title}`);
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      Player.applyMediaDefault(document.querySelector('audio'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL() });
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async playVideoItem(item, title, idx) {
      this.panel.log(`开始播放视频：${title}`);
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(document.querySelector('video'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL() });
      stopObserve();
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async autoCommentItem(item, typeText, idx) {
      this.panel.log(`开始处理${typeText}：${item.querySelector('h2')?.innerText || ''}`);
      item.click();
      await Utils.sleep(1200);

      // 检查是否开启自动评论功能
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoComment) {
        this.panel.log(`${typeText}已查看，但未开启自动回复功能`);
        idx++;
        this.updateProgress(this.outside, idx);
        history.back();
        await Utils.sleep(1000);
        return idx;
      }

      // 开启了自动评论功能，执行评论逻辑
      window.scrollTo(0, document.body.scrollHeight);
      await Utils.sleep(800);
      window.scrollTo(0, 0);
      const commentSelectors = ['#new_discuss .new_discuss_list .cont_detail', '.new_discuss_list dd .cont_detail', '.cont_detail.word-break'];
      let firstComment = '';
      for (let retry = 0; retry < 30 && !firstComment; retry++) {
        for (const sel of commentSelectors) {
          const list = document.querySelectorAll(sel);
          for (const node of list) {
            if (node?.innerText?.trim()) {
              firstComment = node.innerText.trim();
              break;
            }
          }
          if (firstComment) break;
        }
        if (!firstComment) await Utils.sleep(500);
      }
      if (!firstComment) {
        this.panel.log('未找到评论内容，跳过该项');
      } else {
        const input = document.querySelector('.el-textarea__inner');
        if (input) {
          input.value = firstComment;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await Utils.sleep(800);
          const sendBtn = document.querySelector('.el-button.submitComment') ||
            document.querySelector('.publish_discuss .postBtn button') ||
            document.querySelector('.el-button--primary');
          if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains('is-disabled')) {
            sendBtn.click();
            this.panel.log(`已在${typeText}区发表评论`);
          } else {
            this.panel.log('发送按钮不可用或不存在');
          }
        } else {
          this.panel.log('未找到评论输入框，跳过');
        }
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1000);
      return idx;
    }

    async handleHomework(item, idx) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭AI自动答题，跳过该项');
        idx++;
        this.updateProgress(this.outside, idx);
        return idx;
      }
      this.panel.log('进入作业，启动 OCR + AI');
      item.click();
      await Utils.sleep(1500);
      let i = 0;
      const maxRetry = 3; // 最大重试次数
      while (true) {
        const items = document.querySelectorAll('.subject-item.J_order');
        if (i >= items.length) {
          this.panel.log(`所有题目处理完毕，共 ${items.length} 题，准备交卷`);
          break;
        }
        const listItem = items[i];
        listItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        listItem.click();
        await Utils.sleep(1800);
        const disabled = document.querySelectorAll('.el-button.el-button--info.is-disabled.is-plain');
        if (disabled.length > 0) {
          this.panel.log(`第 ${i + 1} 题已完成，跳过...`);
          i++;
          continue;
        }
        const targetEl = document.querySelector('.item-type')?.parentElement || document.querySelector('.item-body');
        let optionCount = 0;
        const listContainer = targetEl?.querySelector('.list-inline.list-unstyled-radio') ||
          targetEl?.querySelector('.list-unstyled.list-unstyled-radio') ||
          targetEl?.querySelector('ul.list');
        if (listContainer) optionCount = listContainer.querySelectorAll('li').length;
        const ocrResult = await Solver.recognize(targetEl);
        if (ocrResult && ocrResult.length > 5) {
          let retryCount = 0;
          let success = false;
          while (retryCount < maxRetry && !success) {
            try {
              if (retryCount > 0) {
                this.panel.log(`🔄 第 ${i + 1} 题重试 ${retryCount}/${maxRetry}...`);
              }
              panel.log('🤖 请求 AI 获取答案...');
              const aiText = await Solver.askAI(ocrResult, optionCount);
              await Solver.autoSelectAndSubmit(aiText, targetEl);
              success = true;
            } catch (err) {
              retryCount++;
              this.panel.log(`AI 答题失败：${err}`);
              if (retryCount < maxRetry) {
                this.panel.log(`等待 5 秒后重试...`);
                await Utils.sleep(5000);
              } else {
                this.panel.log(`⚠️ 第 ${i + 1} 题重试 ${maxRetry} 次后仍失败，跳过`);
              }
            }
          }
        }
        await Utils.sleep(1500);
        i++;
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1200);
      return idx;
    }

    async handleClassroom(course) {
      this.panel.log('进入课堂模式...');
      course.click();
      await Utils.sleep(5000);
      const iframe = document.querySelector('iframe.lesson-report-mobile');
      if (!iframe || !iframe.contentDocument) {
        this.panel.log('未找到课堂 iframe，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      const video = iframe.contentDocument.querySelector('video');
      const audio = iframe.contentDocument.querySelector('audio');
      if (video) {
        Player.applyMediaDefault(video);
        await Player.waitForEnd(video);
      }
      if (audio) {
        Player.applyMediaDefault(audio);
        await Player.waitForEnd(audio);
      }
      this.updateProgress(this.outside + 1, 0);
      history.go(-1);
      await Utils.sleep(1200);
    }

    // 等待课件视频播放完毕；播放器被关闭（弹窗关闭/元素销毁）时自动重新打开
    async waitCoursewareVideo() {
      const deadline = await Utils.getDDL();
      const start = Date.now();
      let boundVideo = null;
      let stopObserve = () => { };
      let reopenAttempts = 0;
      try {
        while (Date.now() - start < deadline) {
          Utils.dismissPopups();
          const video = document.querySelector('video');
          const display = document.querySelector('.xt_video_player_current_time_display');
          if (!video) {
            // 播放器被关闭或视频元素被销毁，重新打开视频框
            const videoBox = document.querySelector('.video-box');
            if (videoBox && !videoBox.innerText.includes('已完成')) {
              this.panel.log('播放器被关闭，正在重新打开');
              videoBox.click();
              boundVideo = null;
            }
            reopenAttempts++;
            if (reopenAttempts >= 4) {
              this.panel.log('播放器恢复失败，刷新页面重试');
              location.reload();
              return false;
            }
            await Utils.sleep(2000);
            continue;
          }
          reopenAttempts = 0;
          if (!display) {
            // 播放器加载中，等待渲染
            await Utils.sleep(800);
            continue;
          }
          if (video !== boundVideo) {
            stopObserve();
            Player.applySpeed();
            Player.mute();
            boundVideo = video;
            stopObserve = Player.observePause(video);
          }
          const times = display.innerText || '';
          const [nowTime, totalTime] = times.split(' / ');
          if (nowTime && totalTime && nowTime === totalTime) return true;
          await Utils.sleep(800);
        }
        return false;
      } finally {
        stopObserve();
      }
    }

    async handleCourseware(course) {
      const tableData = course.parentNode?.parentNode?.parentNode?.__vue__?.tableData;
      const deadlinePassed = (tableData?.deadline || tableData?.end) ? (tableData.deadline < Date.now() || tableData.end < Date.now()) : false;
      if (deadlinePassed) {
        this.panel.log(`${course.querySelector('h2')?.innerText || '课件'} 已结课，跳过`);
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      course.click();
      await Utils.sleep(3000);

      // 检测"查看课件"按钮（课件概况页专用）
      const checkBtn = document.querySelector('.ppt_img_box .check') || document.querySelector('p.check');
      if (checkBtn && checkBtn.innerText?.trim() === '查看课件') {
        this.panel.log('检测到"查看课件"按钮，正在点击...');
        checkBtn.click();
        await Utils.sleep(2000);
      }
      const classType = document.querySelector('.el-card__header')?.innerText || '';
      const className = document.querySelector('.dialog-header')?.firstElementChild?.innerText || '课件';
      if (classType.includes('PPT')) {
        const slides = document.querySelector('.swiper-wrapper')?.children || [];
        this.panel.log(`开始播放 PPT：${className}`);
        for (let i = 0; i < slides.length; i++) {
          slides[i].click();
          this.panel.log(`${className}：第 ${i + 1} 张`);
          await Utils.sleep(Config.pptInterval);
        }
        await Utils.sleep(Config.pptInterval);
        const videoBoxes = document.querySelectorAll('.video-box');
        if (videoBoxes?.length) {
          this.panel.log('PPT 中有视频，继续播放');
          for (let i = 0; i < videoBoxes.length; i++) {
            if (videoBoxes[i].innerText === '已完成') {
              this.panel.log(`第 ${i + 1} 个视频已完成，跳过`);
              continue;
            }
            videoBoxes[i].click();
            await Utils.sleep(2000);
            await this.waitCoursewareVideo();
          }
        }
        this.panel.log(`${className} 已播放完毕`);
      } else {
        const videoBox = document.querySelector('.video-box');
        if (videoBox) {
          videoBox.click();
          await Utils.sleep(1800);
          await this.waitCoursewareVideo();
          this.panel.log(`${className} 视频播放完毕`);
        }
      }
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1000);
    }
  }

  // ---- pro/lms 目录页：挑选可播视频叶子并进入播放 ----
  class DirectoryRunner {
    constructor(panel) {
      this.panel = panel;
    }
    leafInfo(leaf) {
      const typeIcon = (leaf.querySelector('.leaf-title i, i')?.className) || '';
      const stateIcons = [...leaf.querySelectorAll('.progress-time i')].map(i => i.className).join(' ');
      const allText = (leaf.innerText || '') + ' ' + stateIcons;
      // 锁定只认真正的锁图标/未解锁字样；"未开始"只是没看过，仍然可播
      const locked = /icon--suo|lock|suoding/.test(stateIcons) || /未解锁|锁定/.test(allText);
      const finished = /wancheng|finish|yiwancheng|complete|icon--dui|gou|correct/.test(stateIcons)
        || /(^|[^0-9])100%|已完成|已看完|已读/.test(allText);
      return { typeIcon, locked, finished };
    }
    async run() {
      this.panel.log('正在目录页挑选可播放的视频课时...');
      // 播放页（新标签页）可能没有 .leaf-detail：先等叶子出现，若等到的是播放器则直接接管
      const hasLeaves = await Utils.poll(() =>
        document.querySelectorAll('.leaf-detail').length > 0
        || document.querySelector('.btn-next') || document.querySelector('.header-bar') || document.querySelector('video'),
        { interval: 500, timeout: 12000 });
      if (hasLeaves && !document.querySelectorAll('.leaf-detail').length) {
        this.panel.log('当前是播放页，直接接管播放');
        await new PlayerRunner(this.panel).run().catch(e => this.panel.log('播放异常：' + (e.message || e)));
        return;
      }
      if (!hasLeaves) {
        this.panel.log('页面未识别（既非目录也非播放页），请手动进入课时后重试');
        this.panel.resetStartButton('开始刷课');
        return;
      }
      const leafDetail = [...document.querySelectorAll('.leaf-detail')];
      const batch = Store.getBatch();
      const classroomId = Utils.getCurrentClassroomId();
      const expectKey = sessionStorage.getItem('ykt_expect_card');
      if (batch && classroomId && expectKey) {
        // 记录 课程ID -> 卡片文本 映射（仅本标签选进来的课），完成时准确回标对应卡片
        sessionStorage.removeItem('ykt_expect_card');
        batch.map = batch.map || {};
        batch.map[classroomId] = expectKey;
        localStorage.setItem(Config.storageKeys.batch, JSON.stringify(batch));
      }
      const finishCourse = async (done) => {
        Store.unclaimCourse(classroomId);
        const key = (batch && batch.map && batch.map[classroomId]) || classroomId || (batch && batch.current);
        if (batch) {
          Store.addBatchList(done ? 'done' : 'skipped', key);
          this.panel.log(done ? '本课程已无可刷课时，返回列表挑下一门' : '本课程视频未解锁，先跳过，返回列表挑下一门');
          await Utils.sleep(1500);
          location.href = batch.courselistUrl;
        } else {
          this.panel.resetStartButton('开始刷课');
        }
      };
      // 从头扫到尾：可播性由叶子自身的锁定/完成图标判断，不依赖可能过期的计数器
      // 新标签页检测：window.open 钩子挂 window 级标志（跨多次 run 调用不失效）
      if (!window.__yktOpenHook) {
        const origOpen = window.open;
        window.open = function (...args) {
          const w = origOpen.apply(window, args);
          if (w) window.__yktOpened = true; // 被拦截时返回 null，不误判
          return w;
        };
        window.__yktOpenHook = true;
      }
      let clickedAny = false;
      for (let i = 0; i < leafDetail.length; i++) {
        const info = this.leafInfo(leafDetail[i]);
        if (!info.typeIcon.includes('shipin')) {
          Store.setProClassCount(i + 2);
          continue;
        }
        if (info.finished) {
          Store.setProClassCount(i + 2);
          continue;
        }
        if (info.locked) continue;

        // 新标签页检测双保险：原生 blur 监听 + window.open 钩子（点前重置两个标志）
        let blurred = false;
        const realAdd = window._addEventListener ? window._addEventListener.bind(window) : window.addEventListener.bind(window);
        realAdd('blur', () => { blurred = true; }, { once: true });
        window.__yktOpened = false;
        await Utils.jsleep(800);
        leafDetail[i].click();
        clickedAny = true;
        Store.setProClassCount(i + 1);
        this.panel.log('已点击课时，等待播放页加载...');

        const result = await Utils.poll(() =>
          blurred || window.__yktOpened
          || document.querySelector('.btn-next') || document.querySelector('.header-bar') || document.querySelector('video'),
          { interval: 400, timeout: 7000 });
        if (blurred || window.__yktOpened) {
          this.panel.log('播放页已在新标签页打开，本页待命（由那边自动接管）');
          return;
        }
        if (result) {
          this.panel.log('检测到播放界面，接管播放');
          await new PlayerRunner(this.panel).run().catch(e => this.panel.log('播放异常：' + (e.message || e)));
          return;
        }
        this.panel.log('点击无响应，尝试下一条可播课时');
      }
      // 没有任何一条能打开播放页
      const hasLockedVideo = leafDetail.some(l => { const i = this.leafInfo(l); return i.typeIcon.includes('shipin') && i.locked && !i.finished; });
      this.panel.log(hasLockedVideo ? '未找到可点击的视频课时（均未解锁）' : '未找到可点击的视频课时（均已完成或无响应）');
      await finishCourse(!hasLockedVideo);
    }
  }

  // ---- pro/lms 新版（主要逻辑） ----
  class PlayerRunner {
    constructor(panel) {
      this.panel = panel;
    }
    getClassName() {
      return document.querySelector('.header-bar')?.firstElementChild?.innerText
        || document.querySelector('section.title')?.firstElementChild?.innerText || '';
    }
    getClassType() {
      return document.querySelector('.header-bar')?.firstElementChild?.firstElementChild?.getAttribute('class')
        || document.querySelector('section.title')?.firstElementChild?.firstElementChild?.getAttribute('class') || '';
    }
    getStatusText() {
      const deep = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title');
      if (deep) return deep.lastElementChild?.innerText || '';
      const sec = document.querySelector('section.title');
      if (sec) return sec.lastElementChild?.innerText || '';
      // 优先复用上次找到的百分比元素（仍在文档内且文本仍像状态值）
      const re = /^\s*(\d{1,3}%|已完成|已读)\s*$/;
      if (this._statusEl && document.contains(this._statusEl) && re.test(this._statusEl.innerText || '')) {
        return this._statusEl.innerText;
      }
      this._statusEl = null;
      // 限定在播放器/内容容器内找，避免匹配到页面其它角落的百分比文本
      const scopes = ['#app .viewContainer', '[class*=viewContainer]', '[class*=player]', 'main', '#app'];
      for (const sel of scopes) {
        const scope = document.querySelector(sel);
        if (!scope) continue;
        const el = [...scope.querySelectorAll('span,div')].find(e =>
          e.children.length === 0 && re.test(e.innerText || ''));
        if (el) { this._statusEl = el; return el.innerText; }
      }
      return '';
    }
    async run() {
      preventScreenCheck();
      // 后台巡守：定时关闭"好好学习/报告老师"等防挂机弹窗
      if (!this._popupTimer) this._popupTimer = setInterval(() => Utils.dismissPopups(), 15000);
      let classCount = Store.getProClassCount();
      let errStreak = 0;
      let lessonsDone = 0;
      while (true) {
        try {
        // 拟人：随机倍速 + 随机节奏
        Config.playbackRate = Config.speedPool[Math.floor(Math.random() * Config.speedPool.length)] || 2;
        this.panel.log(`准备播放第 ${classCount} 集（倍速 ${Config.playbackRate}x）...`);
        if (lessonsDone > 0 && lessonsDone % Config.restEveryLessons === 0) {
          const restSec = Math.round(Utils.rand(Config.restMinSec, Config.restMaxSec));
          this.panel.log(`已连刷 ${lessonsDone} 集，模拟休息 ${Math.round(restSec / 60)} 分钟防检测…`);
          await Utils.sleep(restSec * 1000);
        }
        await Utils.jsleep(2000);
        const className = this.getClassName();
        const classType = this.getClassType();
        const classStatus = this.getStatusText();
        if (classType.includes('tuwen') && !classStatus.includes('已读')) {
          this.panel.log(`正在阅读：${className}`);
          await Utils.jsleep(2000);
        } else if (classType.includes('taolun')) {
          this.panel.log(`讨论区暂不自动发帖，${className}`);
          await Utils.jsleep(2000);
        } else if (classType.includes('shipin') && !classStatus.includes('100%')) {
          this.panel.log(`2s 后开始播放：${className}`);
          await Utils.sleep(2000);
          let statusTimer;
          let videoTimer;
          try {
            statusTimer = setInterval(() => {
              const status = this.getStatusText();
              if (status.includes('100%') || status.includes('99%') || status.includes('98%') || status.includes('已完成')) {
                this.panel.log(`${className} 播放完毕`);
                clearInterval(statusTimer);
                statusTimer = null;
              }
            }, 200);

            const videoWaitStart = Date.now();
            videoTimer = setInterval(() => {
              const video = document.querySelector('video');
              if (video) {
                sessionStorage.removeItem(Config.storageKeys.reloadCount); // 成功后清零
                setTimeout(() => {
                  Player.applySpeed();
                  Player.mute();
                  Player.observePause(video);
                }, 2000);
                clearInterval(videoTimer);
                videoTimer = null;
              } else if (Date.now() - videoWaitStart > 20000) {
                if (Store.getReloadCount() >= 2) {
                  this.panel.log('视频多次加载失败，跳过本集');
                  sessionStorage.removeItem(Config.storageKeys.reloadCount); // 跳过后清零，不拖累下一集
                  clearInterval(videoTimer); videoTimer = null;
                } else {
                  Store.bumpReloadCount();
                  location.reload();
                }
              }
            }, 5000);

            await Utils.sleep(8000);
            await Utils.poll(() => Utils.isProgressDone(this.getStatusText()), { interval: 1000, timeout: await Utils.getDDL() });
          } finally {
            if (statusTimer) clearInterval(statusTimer);
            if (videoTimer) clearInterval(videoTimer);
          }
        } else if (classType.includes('zuoye')) {
          this.panel.log(`进入作业：${className}（暂无自动答题）`);
          await Utils.jsleep(2000);
        } else if (classType.includes('kaoshi')) {
          this.panel.log(`进入考试：${className}（不会自动答题）`);
          await Utils.jsleep(2000);
        } else if (classType.includes('ketang')) {
          this.panel.log(`进入课堂：${className}（暂无自动功能）`);
          await Utils.jsleep(2000);
        } else {
          this.panel.log(`已看过：${className}`);
          await Utils.jsleep(2000);
        }
        this.panel.log(`第 ${classCount} 集播放完毕`);
        errStreak = 0;
        lessonsDone++;
        classCount++;
        Store.setProClassCount(classCount);
        // btn-next 在切集过场中可能短暂消失：等 6s 确认真的没有了再判课程结束
        const nextBtn = await Utils.poll(() => document.querySelector('.btn-next'), { interval: 400, timeout: 6000 })
          .then(() => document.querySelector('.btn-next'));
        if (nextBtn) {
          const event1 = new Event('mousemove', { bubbles: true });
          event1.clientX = Math.floor(Utils.rand(50, Math.max(200, window.innerWidth - 50)));
          event1.clientY = Math.floor(Utils.rand(50, Math.max(200, window.innerHeight - 50)));
          nextBtn.dispatchEvent(event1);
          await Utils.jsleep(600);
          nextBtn.dispatchEvent(new Event('click'));
        } else {
          localStorage.removeItem(Store.proCountKey());
          this.panel.log('课程播放完毕 🎉');
          const batch = Store.getBatch();
          Store.clearPendingAutoStart();
          const cid = Utils.getCurrentClassroomId();
          Store.unclaimCourse(cid);
          if (batch) Store.addBatchList('done', (batch.map && batch.map[cid]) || cid || batch.current);
          if (batch && batch.courselistUrl) {
            this.panel.log('批量模式：返回课程列表挑选下一门…');
            await Utils.sleep(1500);
            location.href = batch.courselistUrl;
          } else {
            this.panel.resetStartButton('开始刷课');
          }
          break;
        }
        } catch (err) {
          errStreak++;
          this.panel.log(`本集异常：${err.message || err}（连续 ${errStreak} 次）`);
          if (errStreak >= 5) { this.panel.log('连续异常过多，停止以防死循环'); this.panel.resetStartButton('开始刷课'); break; }
          await Utils.jsleep(5000);
          classCount++;
          Store.setProClassCount(classCount);
          const nb = document.querySelector('.btn-next');
          if (nb) nb.dispatchEvent(new Event('click'));
          else break;
        }
      }
    }
  }

  // ---- ai-workspace 新版学习空间 ----
  class CourseRunner {
    constructor(panel) {
      this.panel = panel;
    }

    getExerciseQuestionLabel(root) {
      const tabs = CourseDom.getExerciseQuestionTabs(root);
      const active = tabs.find(tab => /active|current|selected|is-active/.test(tab.className));
      return CourseDom.normalizeText(active?.innerText || '');
    }

    // 获取要跳转回去的目标地址
    getReturnUrl() {
      const pending = Store.getPendingAutoStart();
      const route = CourseDom.getRoute();
      if (!pending || !route) return '';
      if (pending.classroomId !== route.classroomId) return '';
      console.log(`returnUrl:${pending.returnUrl}`)
      return pending.returnUrl || '';
    }

    async autoSelect() {
      if (Store.isPaused()) { this.panel.log('已暂停，停止推进下一条'); return; }
      if (Store.isAssistMode()) { this.panel.log('答题助手模式：停在本页，答完请关闭助手继续刷课'); return; }
      // 优先侧边栏连播：页内直接点下一条，不整页回目录（避免重复加载和重复触发验证码）
      this.source = CourseDom.getAllScourse(); // 得到课程列表
      if (this.source && this.source.length) {
        this.panel.log("检测到侧边栏课程列表，页内连播下一条");
        this.activateIndex = Array.from(this.source).findIndex(el => el.firstChild.classList.contains("is-active")) // 现在正在刷第几个（从0开始）
        await this.handleNext(this.activateIndex + 1)
        return;
      }
      const returnUrl = this.getReturnUrl()
      // 无侧边栏时退回目录页重新匹配（兼容从 pro/lms 目录进入的场景）
      if (returnUrl) {
        await this.returnToSource(returnUrl)
      } else {
        this.panel.log('未发现课程目录，停止当前轮次');
      }
    }

    // 获取父窗口对象 window.opener
    getSourceWindow() {
      try {
        if (!window.opener || window.opener.closed) return null;
        if (window.opener.location.origin !== location.origin) return null;
        return window.opener;
      } catch (_) {
        return null;
      }
    }

    async returnToSource(returnUrl) {
      this.panel.log('媒体播放完成，返回课程目录页继续匹配');
      await Utils.sleep(1200);
      const sourceWindow = this.getSourceWindow();
      console.log(sourceWindow);
      if (sourceWindow) {
        try {
          sourceWindow.location.href = returnUrl;
          sourceWindow.focus();
          window.close();
          return true;
        } catch (e) {
          console.error("跳转父窗口异常", e);
        }
      }
      // 无 opener（手动开的标签）：当前标签直接跳回目录页，否则播完会停在原地
      if (returnUrl && location.href !== returnUrl) {
        location.href = returnUrl;
      } else {
        history.back();
      }
      return true;
    }

    async handleMedia(route) {
      const title = CourseDom.getActiveLeafTitle() || `${route.type} ${route.leafId}`;
      this.panel.log(`开始播放：${title}`);
      const ready = await Utils.poll(() => Boolean(CourseDom.getMedia()), { interval: 500, timeout: 20000 });
      let media = CourseDom.getMedia();
      if (!ready || !media) {
        this.panel.log('未找到视频/音频元素，停止当前轮次');
        return false;
      }

      const playbackState = { completed: false };
      const shouldResume = () => !playbackState.completed;
      let stopObserve = () => { };
      if (media.tagName.toLowerCase() === 'video') {
        Player.applySpeed();
        Player.mute();
        stopObserve = Player.observePause(media, shouldResume);
      } else {
        Player.applyMediaDefault(media);
      }
      const stopKeepAlive = CourseDom.keepAlive(shouldResume);
      this.panel.log(`已接管播放器：${media.tagName.toLowerCase()}，目标倍速 ${Config.playbackRate}x，静音开启`);
      try {
        let startTime = Number(media.currentTime || 0);
        const started = await Utils.poll(() => {
          const currentMedia = CourseDom.getMedia();
          if (currentMedia) media = currentMedia;
          if (!media) return false;
          const currentTime = Number(media.currentTime || 0);
          return currentTime > startTime + 0.5 || (!media.paused && media.readyState >= 2 && currentTime > startTime + 0.2);
        }, { interval: 500, timeout: 15000 });
        if (!started) {
          this.panel.log('未确认到视频实际开始播放，停止当前轮次');
          return false;
        }
        startTime = Number(media.currentTime || 0);

        let resolveEnded;
        const endedPromise = new Promise(resolve => {
          resolveEnded = resolve;
        });
        const onEnded = () => {
          playbackState.completed = true;
          resolveEnded(true);
        };
        media.addEventListener('ended', onEnded);
        const done = await Promise.race([
          endedPromise,
          Utils.poll(() => {
            if (playbackState.completed) return true;
            const currentMedia = CourseDom.getMedia();
            if (currentMedia) media = currentMedia;
            if (CourseDom.isPlayerDone(media, { startTime, minPlayedDelta: 3 })) {
              playbackState.completed = true;
              return true;
            }
            return false;
          }, { interval: 1000, timeout: await Utils.getDDL() })
        ]);
        media.removeEventListener('ended', onEnded);
        playbackState.completed = true;
        if (!done) {
          this.panel.log('等待播放完成超时，停止当前轮次');
          return false;
        }
      } finally {
        stopObserve();
        stopKeepAlive();
      }

      this.panel.log(`${title} 播放完成`);
      return true;
    }

    async solveExerciseQuestion(root, label = '') {
      const questionRoot = CourseDom.getExerciseQuestionBody(root);
      if (!questionRoot) {
        this.panel.log('未找到题目容器，停止当前轮次');
        return false;
      }
      if (CourseDom.isExerciseAnswered(questionRoot)) {
        this.panel.log(`${label || '当前题目'} 已完成，跳过`);
        return true;
      }

      const listContainer = questionRoot.querySelector('.list-inline.list-unstyled-radio')
        || questionRoot.querySelector('.list-unstyled.list-unstyled-radio')
        || questionRoot.querySelector('.list-unstyled')
        || questionRoot.querySelector('ul.list')
        || questionRoot.querySelector('[class*="option-list"]')
        || questionRoot.querySelector('[class*="answer-list"]')
        || questionRoot.querySelector('ul')
        || questionRoot.querySelector('[role="radiogroup"]');
      const optionCount = listContainer
        ? listContainer.querySelectorAll('li, .option-item, .answer-item, [class*="option-item"], [class*="answer-item"]').length
        : 0;
      if (!optionCount) {
        this.panel.log(`${label || '当前题目'} 未找到选项，跳过`);
        return false;
      }

      const ocrResult = await Solver.recognize(questionRoot);
      if (!ocrResult || ocrResult.length <= 5) {
        this.panel.log(`${label || '当前题目'} OCR 结果过短，跳过`);
        return false;
      }

      const maxRetry = 3;
      for (let retryCount = 0; retryCount < maxRetry; retryCount++) {
        try {
          if (retryCount > 0) this.panel.log(`${label || '当前题目'} 重试 ${retryCount}/${maxRetry - 1}`);
          this.panel.log('🤖 请求 AI 获取答案...');
          const aiText = await Solver.askAI(ocrResult, optionCount);
          await Solver.autoSelectAndSubmit(aiText, questionRoot);
          await Utils.sleep(1200);
          return true;
        } catch (err) {
          this.panel.log(`AI 答题失败：${err}`);
          if (retryCount < maxRetry - 1) await Utils.sleep(5000);
        }
      }
      return false;
    }

    async advanceExerciseQuestion(root, previousFingerprint = '') {
      const currentRoot = CourseDom.getExerciseContainer() || root;
      const nextBtn = CourseDom.getExerciseActionButton(currentRoot, /下一题|下一道|下一步/);
      if (!nextBtn) return false;
      nextBtn.click();
      return Utils.poll(() => {
        const latestRoot = CourseDom.getExerciseContainer() || currentRoot;
        const questionRoot = CourseDom.getExerciseQuestionBody(latestRoot);
        const fingerprint = CourseDom.normalizeText(questionRoot?.innerText || '').slice(0, 120);
        return fingerprint && fingerprint !== previousFingerprint;
      }, { interval: 500, timeout: 5000 });
    }

    async handleExercise(route) {
      const bank = QUESTION_BANK[route.classroomId];
      const useBank = Store.isAnswerMode() && !!bank;
      // 优先级：答题模式+白名单 → 本地题库；否则 autoAI 开 → 原 AI 答题；都关 → 跳过
      if (!useBank) {
        const featureFlags = Store.getFeatureConf();
        if (!featureFlags.autoAI) {
          this.panel.log(bank ? '做题一体未开启，作业跳过（面板开关可开启）' : '本课程不在题库白名单且未开 AI 答题，作业跳过');
          return true;
        }
        this.panel.log(bank ? '做题一体未开启，本课程作业走 AI 答题（autoAI 已开）' : '非白名单课程，作业走 AI 答题（autoAI 已开）');
        return this.handleExerciseByAI(route);
      }

      const ready = await Utils.poll(() => Boolean(CourseDom.getExerciseContainer()), { interval: 500, timeout: 20000 });
      const root = CourseDom.getExerciseContainer();
      if (!ready || !root) {
        this.panel.log('未找到作业容器，停止当前轮次');
        return false;
      }

      const leafTitle = CourseDom.getActiveLeafTitle();
      const resolved = bankAnswersFor(bank, leafTitle);
      if (!resolved) {
        this.panel.log(`题库未覆盖本作业（${leafTitle || route.leafId}），留空不提交`);
        return true;
      }
      const answers = resolved.answers;
      this.panel.log(`本地题库作答：${leafTitle || route.leafId}（${resolved.key}，共 ${answers.filter(Boolean).length} 题有答案）`);

      let filled = 0;
      const missed = [];
      const answerOne = async (idx, label) => {
        const currentRoot = CourseDom.getExerciseContainer() || root;
        const body = CourseDom.getExerciseQuestionBody(currentRoot);
        const ans = answers[idx];
        if (!ans) { missed.push(idx + 1); return; }
        if (body && CourseDom.isExerciseAnswered(body)) { filled++; return; }
        if (Store.isPaused()) return;
        const picked = body ? await Solver.selectOptions(body, ans) : 0;
        if (picked) { filled++; this.panel.log(`${label}：选 ${ans === 'T' ? '√' : ans === 'F' ? '×' : ans}`); }
        else { missed.push(idx + 1); this.panel.log(`${label}：未找到可勾选选项，留空`); }
      };

      const tabs = CourseDom.getExerciseQuestionTabs(root);
      if (tabs.length) {
        this.panel.log(`检测到题目索引 ${tabs.length} 个，按题号顺序作答`);
        for (let i = 0; i < Math.max(tabs.length, answers.length); i++) {
          if (Store.isPaused()) { this.panel.log('已暂停，中止作答'); return true; }
          const currentRoot = CourseDom.getExerciseContainer() || root;
          const tab = CourseDom.getExerciseQuestionTabs(currentRoot)[i];
          if (tab) { tab.click(); await Utils.sleep(900); }
          else if (i >= answers.length) break;
          await answerOne(i, `第 ${i + 1} 题`);
          await Utils.sleep(250);
        }
      } else {
        // 无题号导航：按"下一题"按钮逐题推进，序号对齐答案序列
        this.panel.log('未找到题号索引，按页面顺序逐题作答');
        let prev = '';
        for (let i = 0; i < Math.min(answers.length, 80); i++) {
          if (Store.isPaused()) { this.panel.log('已暂停，中止作答'); return true; }
          const currentRoot = CourseDom.getExerciseContainer() || root;
          const body = CourseDom.getExerciseQuestionBody(currentRoot);
          const fp = CourseDom.normalizeText(body?.innerText || '').slice(0, 120);
          if (!fp || (i > 0 && fp === prev)) break;
          await answerOne(i, `第 ${i + 1} 题`);
          prev = fp;
          const moved = await this.advanceExerciseQuestion(currentRoot, fp);
          if (!moved) break;
        }
      }

      // 提交门控：有任何留空题 → 不提交（提交不可撤销，宁可人工补）
      if (missed.length) {
        this.panel.log(`⚠️ 题库未覆盖/未勾选第 ${missed.join('、')} 题，已作答 ${filled} 题，【不自动提交】请人工核对补答`);
        return true;
      }
      if (!filled) {
        this.panel.log('未能勾选任何选项，不提交');
        return true;
      }
      const submitBtn = Solver.clickSubmit(root);
      if (submitBtn) {
        this.panel.log(`✅ ${filled} 题全部按题库作答完成，提交中…`);
        submitBtn.click();
        await Utils.sleep(1500);
      } else {
        this.panel.log('⚠️ 未找到提交按钮，请手动提交');
      }
      return true;
    }

    // 原 AI 答题路径：仅在机主面板开启"自动答题(autoAI)"时才会走到（默认关）
    async handleExerciseByAI(route) {
      const ready = await Utils.poll(() => Boolean(CourseDom.getExerciseContainer()), { interval: 500, timeout: 20000 });
      const root = CourseDom.getExerciseContainer();
      if (!ready || !root) {
        this.panel.log('未找到作业容器，停止当前轮次');
        return false;
      }

      this.panel.log(`开始 AI 处理作业：${CourseDom.getActiveLeafTitle() || route.leafId}`);
      const tabs = CourseDom.getExerciseQuestionTabs(root);
      if (tabs.length) {
        this.panel.log(`检测到题目索引 ${tabs.length} 个，按题号顺序作答`);
        for (let i = 0; i < tabs.length; i++) {
          if (Store.isPaused()) { this.panel.log('已暂停，中止作答'); return true; }
          const currentRoot = CourseDom.getExerciseContainer() || root;
          const currentTabs = CourseDom.getExerciseQuestionTabs(currentRoot);
          const currentTab = currentTabs[i];
          if (!currentTab) break;
          currentTab.click();
          await Utils.sleep(1200);
          await this.solveExerciseQuestion(CourseDom.getExerciseContainer() || currentRoot, `第 ${i + 1} 题`);
        }
        return true;
      }

      this.panel.log('未找到题号列表，尝试只处理当前题并按下一题推进');
      let previousFingerprint = '';
      for (let i = 0; i < 20; i++) {
        if (Store.isPaused()) { this.panel.log('已暂停，中止作答'); return true; }
        const currentRoot = CourseDom.getExerciseContainer() || root;
        const questionRoot = CourseDom.getExerciseQuestionBody(currentRoot);
        const fingerprint = CourseDom.normalizeText(questionRoot?.innerText || '').slice(0, 120);
        if (!fingerprint) break;
        if (i > 0 && fingerprint === previousFingerprint) break;
        await this.solveExerciseQuestion(currentRoot, this.getExerciseQuestionLabel(currentRoot) || `第 ${i + 1} 题`);
        previousFingerprint = fingerprint;
        const moved = await this.advanceExerciseQuestion(currentRoot, fingerprint);
        if (!moved) break;
      }
      return true;
    }

    // 直接在ai-workspace页面处理课程的逻辑
    async handleNext(count) {
      // 跳过两类 leaf：① 带"已完成"勾的（icon-yuanquangou-mianzhuang）不重播
      // ② 非视频/音频 leaf（作业/讨论/图文/考试——点了要么弹确认框要么无意义，run 的类型分支也只会跳过）
      //    例外：答题模式开启且本课程在题库白名单时，"作业" leaf 放行进入作答
      const bankCid = Utils.getCurrentClassroomId();
      const allowExercise = Store.isAnswerMode() && !!QUESTION_BANK[bankCid];
      const isDone = el => !!el.querySelector('.icon-yuanquangou-mianzhuang');
      const isMedia = el => {
        const t = (el.innerText || '').trim();
        if (/^\s*(视频|音频|video|audio)/i.test(t)) return true;
        return allowExercise && /^\s*作业/.test(t);
      };
      while (count < this.source.length) {
        if (Store.isPaused()) { this.panel.log('已暂停，停止挑选下一条'); return; }
        const el = this.source[count];
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (isDone(el) || (txt && !isMedia(el))) { count++; continue; }
        break;
      }
      if (Store.isPaused()) return;
      if (count >= this.source.length) {
        // 收尾复查：重新抓一遍侧边栏，找漏网的未完成媒体项（点击未跳转/播不动被跳过的）
        // 每成功切入一条漏网项即重置标志，允许下轮收尾再查；直到干净才判完成
        if (!this._tailRescanned) {
          this._tailRescanned = true;
          const fresh = CourseDom.getAllScourse();
          if (fresh && fresh.length) this.source = fresh;
          for (let i = 0; i < this.source.length; i++) {
            const el = this.source[i];
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            const active = el.firstChild && el.firstChild.classList && el.firstChild.classList.contains('is-active');
            if (!active && !isDone(el) && t && isMedia(el)) {
              this.panel.log(`课程收尾复查发现漏刷课时：「${t.slice(0, 40)}」，回补中…`);
              return this.handleNext(i);
            }
          }
        }
        this.panel.log('课程刷完啦 🎉');
        this.panel.resetStartButton('刷完啦~');
        Store.clearPendingAutoStart();
        const cid = Utils.getCurrentClassroomId();
        Store.unclaimCourse(cid);
        const batch = Store.getBatch();
        if (batch) {
          Store.addBatchList('done', (batch.map && batch.map[cid]) || cid || batch.current);
          if (batch.courselistUrl) {
            this.panel.log('批量模式：返回课程列表挑选下一门…');
            await Utils.sleep(1500);
            location.href = batch.courselistUrl;
          }
        }
        return;
      }
      const beforeRoute = CourseDom.getRoute();
      this.source[count].firstChild.click();
      await Utils.sleep(2000);
      const afterRoute = CourseDom.getRoute();
      // 点击未导航（考试类弹框/元素失效等）：本层直接试下一条，防止在同 leaf 上死循环
      if (afterRoute && beforeRoute && afterRoute.leafId === beforeRoute.leafId) {
        this.panel.log('点击课时未跳转，跳过该条试下一个');
        return this.handleNext(count + 1);
      }
      this._tailRescanned = false; // 成功切入新课时，允许收尾复查再次生效
      if (!afterRoute) await Utils.sleep(2000); // SPA 路由过渡中，再等等
      await this.run(false)
    }

    async run(preventScreenCheckSwitch = true) {
      if (Store.isPaused()) { this.panel.log('已暂停，本轮不再执行'); return; }
      // 仅开启一次防切屏
      if (preventScreenCheckSwitch) preventScreenCheck();
      const route = CourseDom.getRoute();
      if (!route) {
        this.panel.log('当前页面已离开 ai-workspace/lms-graph');
        return;
      }
      if (!route.leafId) {
        this.panel.log('未能识别当前知识点');
        return;
      }
      let ok = false;
      if (route.type === 'video' || route.type === 'audio') {
        ok = await this.handleMedia(route);
      } else if (route.type === 'exercise') {
        ok = await this.handleExercise(route);
      } else {
        this.panel.log(`当前类型为 ${route.type}，当前暂不自动处理此类型，自动跳过`);
        await Utils.sleep(2000);
        ok = true;
      }
      if (!ok) this.panel.warn("(该视频可能已经刷完了)，即将跳过开始下一个");
      // 继续下一个
      await this.autoSelect()
    }
  }

  // ---- 课程列表页：挑选未完成课程并进入 ----
  async function runCourseList(panel) {
    const picked = await Utils.pickUnfinishedCourse(panel);
    if (!picked) {
      const batch = Store.getBatch();
      const skipped = (batch && batch.skipped) || [];
      const retries = (batch && batch.retryCount) || 0;
      // 有课被标记"未解锁"→ 定时重试直到解锁或达到上限
      if (batch && skipped.length && retries < Config.lockedMaxRetry) {
        batch.retryCount = retries + 1;
        batch.nextRetryTs = Date.now() + Config.lockedRetryMin * 60000;
        batch.ts = Date.now();
        localStorage.setItem(Config.storageKeys.batch, JSON.stringify(batch));
        panel.log(`全部课程暂不可刷（未解锁），${Config.lockedRetryMin} 分钟后自动重试（第 ${batch.retryCount}/${Config.lockedMaxRetry} 次）`);
        panel.resetStartButton('开始刷课');
        setTimeout(() => location.reload(), Math.min(Config.lockedRetryMin, 10) * 60000);
        return;
      }
      // 瞬态（页面没加载出来/登录态抖动）也重试几次
      if (batch && retries < Config.transientRetry) {
        batch.retryCount = retries + 1;
        batch.nextRetryTs = Date.now() + 5 * 60000;
        batch.ts = Date.now();
        localStorage.setItem(Config.storageKeys.batch, JSON.stringify(batch));
        panel.log('页面暂无课程可选（可能未加载完成），5 分钟后自动重试');
        setTimeout(() => location.reload(), 5 * 60000);
        return;
      }
      panel.log('未发现可进入的课程，或全部课程已完成');
      Store.clearBatch();
      panel.resetStartButton('开始刷课');
      return;
    }
    Store.setBatch(location.href, picked.key);
    // 本标签本次要进入的课程卡片：SPA 跳转后目录页据此写 map，多标签不串
    sessionStorage.setItem('ykt_expect_card', picked.key);
    panel.log('批量模式开启，进入课程：' + picked.key.slice(0, 40));
    await Utils.sleep(800);
    const oldPath = location.pathname;
    if (picked.href) {
      const abs = picked.href.startsWith('http') ? picked.href : location.origin + (picked.href.startsWith('/') ? picked.href : '/' + picked.href);
      location.href = abs;
      return;
    }
    picked.el.click();
    // SPA 跳转不会触发整页加载：监听路径变化后接管进入目录页逻辑
    const moved = await Utils.poll(() => location.pathname !== oldPath, { interval: 400, timeout: 8000 });
    if (moved && Utils.isSupportedLearningPage()) {
      panel.log('已进入课程页，自动开始');
      setTimeout(() => start(), 1500);
    } else if (!moved) {
      panel.log('点击卡片未跳转，重试点击卡片内部元素');
      (picked.el.querySelector('h1, .el-card__body, img') || picked.el).click();
      const moved2 = await Utils.poll(() => location.pathname !== oldPath, { interval: 400, timeout: 6000 });
      if (moved2 && Utils.isSupportedLearningPage()) setTimeout(() => start(), 1500);
    }
  }

  // ---- 路由 ----
  function start() {
    // ---- ai-workspace获取课程根目录信息并保存（处理完一个课程重定向到根目录） ----
    const classroomId = Utils.getCurrentClassroomId();
    const returnUrl = Utils.returnUrl()
    Store.setPendingAutoStart(classroomId, returnUrl);
    // 多标签并发：同一门课只允许一个标签刷，撞车的标签回列表另选
    if (classroomId && !Store.claimCourse(classroomId)) {
      const yields = Number(sessionStorage.getItem('ykt_yield_count') || 0) + 1;
      sessionStorage.setItem('ykt_yield_count', yields);
      panel.log(`该课程正在其他标签页刷课中，本标签让出（第 ${yields} 次）`);
      const batch0 = Store.getBatch();
      const busyCount = Object.keys(Store.getClaims()).filter(cid => Store.getClaims()[cid].tab !== Store.getTabId()).length;
      if (batch0 && batch0.courselistUrl && (yields < 8 || busyCount < 7)) {
        setTimeout(() => { location.href = batch0.courselistUrl; }, 1500);
      } else if (batch0 && batch0.courselistUrl) {
        // 剩余课程基本都被别的标签占着：歇 10 分钟再回列表重选
        panel.log('暂无可分配课程，10 分钟后重试');
        setTimeout(() => { location.href = batch0.courselistUrl; }, 10 * 60000);
      } else {
        panel.resetStartButton('开始刷课');
      }
      return;
    }
    sessionStorage.removeItem('ykt_yield_count');
    if (classroomId && !window.__yktClaimBeat) {
      window.__yktClaimBeat = setInterval(() => Store.heartbeatClaim(classroomId), 60000);
    }
    const aiRoute = CourseDom.getRoute();
    if (aiRoute) {
      panel.log(`正在匹配处理逻辑：ai-workspace/lms-graph/${aiRoute.type}`);
      new CourseRunner(panel).run().catch(e => { panel.log('运行异常：' + (e && (e.message || e))); panel.resetStartButton('开始刷课'); });
      return;
    }
    // ---- ai-workspace end
    const url = location.host;
    const path = location.pathname.split('/');
    const matchURL = `${url}${path[0]}/${path[1]}/${path[2]}`;
    panel.log(`正在匹配处理逻辑：${matchURL}`);
    if (Utils.isCourseListPage()) {
      runCourseList(panel).catch(e => { panel.log('选课异常：' + (e.message || e)); panel.resetStartButton('开始刷课'); });
    } else if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
      new LegacyRunner(panel).run();
    } else if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
      const onRunnerErr = e => { panel.log('运行异常：' + (e.message || e)); panel.resetStartButton('开始刷课'); };
      if (document.querySelector('.btn-next')) {
        new PlayerRunner(panel).run().catch(onRunnerErr);
      } else {
        new DirectoryRunner(panel).run().catch(onRunnerErr);
      }
    } else {
      panel.resetStartButton('开始刷课');
      panel.log('当前页面非刷课页面，应匹配 */v2/web/*、*/pro/lms/* 或 */ai-workspace/lms-graph/*');
    }
  }

  // ---- 启动 ----
  async function boot() {
    if (Utils.inIframe()) return;
    // 防检测尽早在 document-start 生效：拦 visibility/blur 监听 + 隐藏 webdriver 痕迹
    try {
      preventScreenCheck();
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    } catch (e) { /* 非致命 */ }
    await Utils.waitForMountTarget();
    try {
      applySpeedPref(); // 启动即应用持久化的倍速偏好（默认 2x，不改动原行为）
      panel = createPanel();
      panel.log(`雨课堂学习助手 v${Config.version} 已加载`);
      panel.setStartHandler(start);
      const pendingAutoStart = Store.getPendingAutoStart();
      const currentClassroomId = Utils.getCurrentClassroomId();
      const batch = Store.getBatch();
      const paused = Store.isPaused();
      if (paused) {
        panel.log('已处于停止状态（点"开始刷课"或"重新加载"恢复）');
      } else if (batch && Utils.isCourseListPage()) {
        const waitMs = (batch.nextRetryTs || 0) - Date.now();
        if (waitMs > 0) {
          panel.log(`批量模式：等待重试，${Math.ceil(waitMs / 60000)} 分钟后自动刷新…`);
          setTimeout(() => location.reload(), waitMs + 2000);
        } else {
          if (batch.nextRetryTs) {
            delete batch.nextRetryTs;
            batch.skipped = []; // 到点了，重试前清掉"未解锁"标记重新尝试
            localStorage.setItem(Config.storageKeys.batch, JSON.stringify(batch));
          }
          panel.log('批量模式：自动挑选下一门未完成课程…');
          setTimeout(() => runCourseList(panel).catch(e => { panel.log('选课异常：' + (e.message || e)); panel.resetStartButton('开始刷课'); }), 1500);
        }
      } else if (batch && Utils.isSupportedLearningPage()) {
        panel.log('批量模式：自动继续刷课');
        setTimeout(() => panel.start(), 1500);
      } else if (
        pendingAutoStart
        && Utils.isSupportedLearningPage()
        && (
          (currentClassroomId && pendingAutoStart.classroomId === currentClassroomId)
          || (!currentClassroomId && location.pathname.includes('/pro/lms/'))
        )
      ) {
        panel.log('检测到跨页面跳转，自动恢复刷课');
        setTimeout(() => panel.start(), 1200);
      } else if (Config.autoStart && Utils.isCourseListPage()) {
        panel.log(`${Config.autoStartDelaySec} 秒后自动开始刷课（点"停止"取消）`);
        setTimeout(() => { if (!Store.isPaused()) panel.start(); }, Config.autoStartDelaySec * 1000);
      }
    } catch (err) {
      console.error('面板初始化失败:', err);
    }
  }

  boot();

})();

}