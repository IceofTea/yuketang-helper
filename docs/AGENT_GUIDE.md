# AGENT GUIDE — yuketang-helper 部署与运维手册

> 给 AI agent / 技术协助者：帮助机主在长江雨课堂（`*.yuketang.cn` 类站点，pro/lms + ai-workspace 架构）部署并运行本脚本。
> 本仓库代码已在真实账号实测：7 门课并行刷课、倍速锁定、页内连播、多标签防撞车、漏刷回补均跑通。

## 0. 包结构

```
yuketang-helper.user.js   # 油猴脚本本体（唯一必须分发的文件）
README.md                 # 给机主的概览
docs/使用指南.md           # 详细使用说明
docs/AGENT_GUIDE.md       # 本文件
tools/
  cdp.py                  # CDP 求值工具（需 websockets：pip install websockets）
  make_inject.py          # 把 userscript 打包成可注入 inject.js
  watchdog.py             # 无人值守注入守护：整页刷新后自动重新注入
```

## 1. 部署路径选择

| 场景 | 方案 |
|---|---|
| 机主可装浏览器扩展 | **方案 A：Tampermonkey**（首选，最稳） |
| 不便装扩展 / 需要 agent 远程代管 | 方案 B：调试端口浏览器 + watchdog 注入 |

### 方案 A：Tampermonkey（推荐）

1. 确认 Edge/Chrome 已装 Tampermonkey；把 `yuketang-helper.user.js` 全文作为新脚本保存并启用
2. 机主登录雨课堂站点
3. 打开课程目录页（`…/pro/lms/<cls>/<courseId>/studycontent`）或列表页 `…/pro/courselist`
4. HUD 面板出现后：目录页点「▶ 开始」；列表页等 10 秒自动开始
5. 多门并行：为每门课各开一个标签，各自点「▶ 开始」

### 方案 B：CDP 无人值守（本仓库实测方案）

```bash
# 1) 用独立 user-data-dir 启动调试版 Edge（不动机主正常浏览器配置）
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 --user-data-dir=C:\ykt-debug ^
  https://<站点域名>/pro/courselist
# 2) 机主在该窗口手动登录一次（统一身份认证）
# 3) 生成注入文件（只需一次；userscript 更新后需重跑）
python tools\make_inject.py        # 产出 tools\inject.js
# 4) 修改 watchdog.py 顶部常量：
#    INJECT  -> tools\inject.js 实际路径（默认读同目录 inject.js）
#    PATTERNS -> 已含 lms-graph / pro/lms / courselist，通常不用改
# 5) 启动守护（持续运行；页面整页刷新后自动重新注入）
python tools\watchdog.py
# 6) 验证任一标签
python tools\cdp.py "(function(){var v=document.querySelector('video');return v?v.playbackRate:'novideo'})()" lms-graph
```

watchdog 工作原理：轮询 `localhost:9222/json/list`，凡 URL 命中 `lms-graph/`、`/pro/lms/`、`courselist` 且既无 `#ykt-hud-frame` 又无 `window.__yktCore` 的页面，注入脚本；注入后由脚本自身的 `batch` / `pendingAutoStart` 机制自动 start。日志写 `watchdog.log`（与脚本同目录）。

注意：CDP 注入在**页面整页刷新时丢失**——watchdog 就是为了补这个。SPA 内导航（leaf→leaf）不丢上下文。

## 2. 脚本运行模型（排障必读）

- **路由** `start()`：`lms-graph` → `CourseRunner`（页内侧边栏连播 `.nav-item-leaf-box`）；`pro/lms` 目录 → `DirectoryRunner`（扫 `.leaf-detail` 点可播视频）；pro 播放页（`.btn-next`）→ `PlayerRunner`；courselist → 选课进课；旧版 v2/web → `LegacyRunner`
- **倍速锁定** `Player.pinSpeed`：对 `playbackRate` 做元素级 setter 劫持，站点回写被吞，我方经原生描述符直写；每 5s 重申。倍速偏好存 `ykt_speed_pref`（localStorage），启动时 `applySpeedPref()` 写回 `Config.speedPool`
- **多标签防撞车**：`Store.claimCourse(classroomId)` 用 localStorage `ykt_claims` 占坑（10min 过期，60s 心跳 `__yktClaimBeat`）；撞车标签自动回 `batch.courselistUrl` 随机另选；同一门课永不双开
- **批量账本** localStorage `ykt_batch`：`{courselistUrl,current,done,skipped,map,ts}`；存在即触发学习页自动 start；`map` 存 `courseId→cardKey`（选课进课时经 sessionStorage `ykt_expect_card` 回传建立）
- **跨页恢复** sessionStorage `ykt_pending_auto_start`（per-tab，TTL 30min）：目录→播放页跳转后自动继续；`returnUrl` 为空时走页内连播
- **漏刷回补**：`CourseRunner.handleNext` 扫到列表尾部时重抓侧边栏，找"未完成+媒体类+非当前项"的漏网 leaf 回补，全部干净才判课程完成
- **HUD 仪表盘**：面板内 1.2s 自采集（侧边栏 leaf 分类统计/激活 index/batch 进度/计时 `ykt_stats_t0`），不依赖 runner 上报。进度条口径：leaf 按 innerText 前缀分类——`视频/音频` 进视频条、`作业` 进作业条、讨论/考试/图文不计入；作业条仅在作业代答开启时显示；「正在播第 X 节」是媒体序号非全 leaf 序号；视频全完成时主条变绿+发光+一次性烟花，作业条同规则；主题存 `ykt_theme`（默认 light，HUD 顶部 🌙/☀️ 切换）
- **作业代答**：localStorage `ykt_answer_mode`，默认关。开启后（HUD 开关+confirm）白名单课程（`QUESTION_BANK`：26960231/26960232）的"作业" leaf 进入并按章节+题号取本地答案勾选提交；`null` 答案=缺失→整卷留空不提交；`autoAI` 开时非白名单走 `handleExerciseByAI` 原 AI 路径；考试 leaf 永不进入
- **答题助手（半自动）**：sessionStorage `ykt_assist`（per-tab，关标签失效），默认关。开启后 `autoSelect` 停推进（停在本页不跳下一条），HUD 金色横幅逐题显示题库答案（`第X/Y题·答案：选A·B·D`，判断题 √/×；无题号 tab 时列全卷答案序号）；脚本只读不代点，由机主亲自勾选提交。与作业代答互斥（开一个自动关另一个）
- **对外接口**：`window.__yktAPI.getStatus()` 返回 `{version, paused, answerMode, assistMode, speed, theme, url, batch, log}`——排查时优先用它而不是 eval 一堆 DOM
- **完成路径**：leaf 全部播完 → unclaim + `batch.done+=courseId` → 回 courselist → 随机选下一门 → 直到全完

## 3. 健康检查（30 秒判定是否在正常刷）

```bash
python tools\cdp.py "(function(){var v=document.querySelector('video');var lg=(window.__yktLog||[]).slice(-4).join(' | ');return{rate:v&&v.playbackRate,t:v&&Math.round(v.currentTime),paused:v&&v.paused,log:lg}})()" <url片段>
```

正常标志：`rate:2`（或所选倍速）、`paused:false`、`t` 递增、log 尾部为"已接管播放器…"或"播放完成→页内连播"。

## 4. 故障排查表

| 症状 | 原因 | 处理 |
|---|---|---|
| `Cannot redefine property: hasFocus` | 旧版本；已修（`preventScreenCheck` 幂等 `__yktEnvPatched`） | 确认脚本为仓库版本，刷新页面 |
| 播完一条后卡住不动 | 旧版本 returnToSource 无 opener 分支为空 | 同上，已修 |
| 日志停在"已点击课时，等待播放页加载" | 页面弹了腾讯验证码 | **让机主手动滑**；不要尝试自动过验证码 |
| `rate` 回到 1 | 站点回写倍速 | pinSpeed 5s 内自动拉回；持续 1x 说明脚本未注入，查 `__yktCore` |
| 面板 iframe 消失但还在刷 | SPA 重渲染销毁了 DOM | 正常：`window.__yktLog` 仍有镜像日志 |
| 两个标签刷同一门 | claim 未生效 | 刷新其中一个，claim 会让它让位 |
| leaf 锁定 `icon--suo` | 课程未开放 | 正常跳过；30min 后自动重试 |
| "课程刷完啦"但还有未完成视频 | 旧版本无收尾复查 | 已修：`handleNext` 尾部漏网回补 |
| 页面上两个面板/日志互相覆盖 | 新旧版本双注入 | reload 该标签；保证注入端只有一份 |
| 进度条分母比侧边栏少 | 正常：只统计视频/音频 leaf | 无需处理 |
| 答题助手横幅显示"未检测到作业页" | 当前不在作业 leaf | 让机主手动点进作业课时；横幅不会代点 |

## 5. 红线（不要做的事）

1. **不要尝试绕过/自动完成腾讯验证码**——让机主手动滑，这是唯一合规路径
2. **不要替机主开启「作业代答」/ AI 自动答题 / 自动评论**——涉及不可撤回提交；默认全关最安全。作业代答仅在机主明确要求并确认题库正确时由机主本人开启。「答题助手」为只读提示，相对安全，但其开启按钮也有 confirm 弹窗——同样需要机主本人在浏览器里点确认
3. **不要修改正在运行中的脚本上下文**（`__yktCore` 守卫会拒绝二次注入）；改代码必须走文件→重建 inject→重启 watchdog
4. 不要动 `yuketang.js` 原版（若存在）；分发文件名必须是 `yuketang-helper.user.js`
5. 并行数建议 ≤3 门更稳；7 门并发已实测可跑但验证码概率上升
6. 不要把机主的 API Key / Cookie / 账号信息写进任何文件或日志

## 6. 重置与维护

- 清进度重新刷：`localStorage.removeItem('ykt_batch')` + 各标签刷新
- 全停：每个标签面板点「⏹ 停止」（写 sessionStorage `ykt_paused`）
- 换机主/换账号：清 localStorage `ykt_*` + sessionStorage，重走部署流程
- 脚本更新：替换 `yuketang-helper.user.js` → 方案 B 需重跑 `make_inject.py` 并重启 watchdog（其内存中缓存注入文件）

## ������ע�⣨2026-11-12 �ȿӣ�
- `һ��ˢ��.exe`��PyInstaller ����� launcher������ʱ�� `tools\inject.js` һ���Զ����ڴ棨`load_inject()`����֮��ע���ȫ���ڴ���ľɰ档`make_inject.py` �ؽ� inject.js �����**���� exe**��ɱ�����ٿ�������ǩ��ˢ�²ųԵ��´��롣C:\Users\Administrator\watchdog.py ͬ���������� `C:\Users\Administrator\inject_test.js`����
- �ж�ҳ���ܵ����¾ɴ��룺__yktAPI.getStatus() ����û�� `examMode` ������ HUD iframe ��� `#btn-exam`��

